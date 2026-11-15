// Verification for the streaming WAV writer in wav.js.
// Run with: node wav.streaming.test.mjs
//
// Covers:
//  - old behavior parity: refactored buildWavURL/buildWavBytes are bit
//    identical to the original implementation taken from git HEAD
//  - byte identity: streamed 16-bit files equal one-shot output
//  - 24-bit streaming header fields and sample quantization
//  - invalid sampleRate/channelCount/bitDepth errors
//  - failure paths delete the partial file
//  - 3 minute material: one-shot vs streamed byte identity

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const root = new URL('.', import.meta.url).pathname;
const loadModule = (source) =>
    import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

const wav = await loadModule(readFileSync(join(root, 'wav.js'), 'utf8'));
// original implementation from git HEAD, proves old behavior is preserved
const original = await loadModule(
    execFileSync('git', ['-C', root, 'show', 'HEAD:wav.js'], {encoding: 'utf8'}));

const tmp = mkdtempSync(join(tmpdir(), 'wav-stream-test-'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const blobBytes = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());

// deterministic PRNG so inputs are reproducible
function mulberry32(seed)
{
    return () =>
    {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// deterministic channels with edge values: clipping, exact +-1, NaN, Infinity
function makeChannels(channelCount, sampleCount, seed)
{
    const rand = mulberry32(seed);
    const edge = [0, 1, -1, 2, -2, 0.5, -0.5, 1/3, NaN, Infinity, -Infinity];
    return Array.from({length: channelCount}, (_, j) =>
    {
        const c = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; ++i)
            c[i] = i < edge.length ? edge[(i + j) % edge.length] : rand() * 3 - 1.5;
        return c;
    });
}

async function streamToFile(path, channels, options, chunkFrames)
{
    const writer = await wav.createWavWriter(path, options);
    const sampleCount = channels[0].length;
    for (let start = 0; start < sampleCount; start += chunkFrames)
        await writer.write(channels.map(c => c.subarray(start, Math.min(sampleCount, start + chunkFrames))));
    return writer.end();
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// 1. old behavior parity: original (git HEAD) vs refactored one-shot
test('old behavior parity: buildWavURL/buildWavBytes bit-identical to original', async () =>
{
    const configs = [
        {channelCount: 1, sampleRate: 44100, sampleCount: 1000},
        {channelCount: 2, sampleRate: 48000, sampleCount: 999},
        {channelCount: 6, sampleRate: 32000, sampleCount: 12345},
        {channelCount: 2, sampleRate: 44100, sampleCount: 1},
        {channelCount: 4, sampleRate: 22050, sampleCount: 7777},
    ];
    for (const [i, cfg] of configs.entries())
    {
        const channels = makeChannels(cfg.channelCount, cfg.sampleCount, 100 + i);
        const originalBytes = await blobBytes(original.buildWavURL(channels, cfg.sampleRate));
        const newBytes = Buffer.from(wav.buildWavBytes(channels, cfg.sampleRate));
        const newUrlBytes = await blobBytes(wav.buildWavURL(channels, cfg.sampleRate));
        assert.ok(newBytes.equals(originalBytes),
            `buildWavBytes differs from original for ${JSON.stringify(cfg)}`);
        assert.ok(newUrlBytes.equals(originalBytes),
            `buildWavURL differs from original for ${JSON.stringify(cfg)}`);
        assert.equal(sha256(newBytes), sha256(originalBytes));
    }
});

// 2. streamed 16-bit file is byte identical to one-shot output
test('byte identity: streamed 16-bit file equals one-shot output', async () =>
{
    const configs = [
        {channelCount: 1, sampleRate: 44100, sampleCount: 1000,  chunkFrames: 100},
        {channelCount: 2, sampleRate: 48000, sampleCount: 999,   chunkFrames: 7},
        {channelCount: 6, sampleRate: 32000, sampleCount: 40000, chunkFrames: 16384}, // crosses chunk boundary
        {channelCount: 2, sampleRate: 44100, sampleCount: 1,     chunkFrames: 1},
        {channelCount: 8, sampleRate: 96000, sampleCount: 50000, chunkFrames: 65536}, // single big write
    ];
    for (const [i, cfg] of configs.entries())
    {
        const channels = makeChannels(cfg.channelCount, cfg.sampleCount, 200 + i);
        const oneShot = Buffer.from(wav.buildWavBytes(channels, cfg.sampleRate));
        const path = join(tmp, `identity-${i}.wav`);
        const info = await streamToFile(path, channels, cfg, cfg.chunkFrames);
        const streamed = readFileSync(path);
        assert.ok(streamed.equals(oneShot),
            `streamed file differs from one-shot for ${JSON.stringify(cfg)}`);
        assert.equal(sha256(streamed), sha256(oneShot));
        assert.equal(info.fileBytes, oneShot.length);
        assert.equal(info.sampleFrames, cfg.sampleCount);
    }
});

// 3. 24-bit streaming: header fields and quantization
test('24-bit streaming: header fields and sample quantization', async () =>
{
    const sampleRate = 48000, channelCount = 2;
    const samples = [0, 0.5, -0.5, 0.9999999, 1, -1, 2, -2];
    const channels = [new Float32Array(samples), new Float32Array(samples).reverse()];
    const path = join(tmp, '24bit.wav');
    const info = await streamToFile(path, channels, {sampleRate, channelCount, bitDepth: 24}, 3);
    const file = readFileSync(path);

    assert.equal(file.toString('ascii', 0, 4), 'RIFF');
    assert.equal(file.toString('ascii', 8, 12), 'WAVE');
    assert.equal(file.toString('ascii', 12, 16), 'fmt ');
    assert.equal(file.readUInt32LE(16), 18);           // fmt chunk size
    assert.equal(file.readUInt16LE(20), 1);            // PCM
    assert.equal(file.readUInt16LE(22), channelCount);
    assert.equal(file.readUInt32LE(24), sampleRate);
    assert.equal(file.readUInt32LE(28), 3*channelCount*sampleRate); // bytes/sec
    assert.equal(file.readUInt16LE(32), 3*channelCount);            // block align
    assert.equal(file.readUInt16LE(34), 24);           // bits per sample
    assert.equal(file.toString('ascii', 38, 42), 'data');
    const dataSize = samples.length * channelCount * 3;
    assert.equal(file.readUInt32LE(42), dataSize);
    assert.equal(file.readUInt32LE(4), dataSize + 46 - 8); // riff size
    assert.equal(file.length, 46 + dataSize);
    assert.equal(info.dataBytes, dataSize);

    // decode samples and compare with expected quantization
    const expected = (s) => (s < 1 ? (s * (1<<23) | 0) : (1<<23) - 1) & 0xffffff;
    assert.equal(file.readUIntLE(46, 3), expected(0) >>> 0);               // frame 0 left
    assert.equal(file.readUIntLE(49, 3), expected(-2) >>> 0);              // frame 0 right (clipped)
    assert.equal(file.readUIntLE(46 + 2*3, 3), expected(0.5) >>> 0);       // frame 1 left
    assert.equal(file.readUIntLE(46 + 3*2*3, 3), expected(0.9999999) >>> 0); // frame 3 left
});

// 4. invalid sampleRate / channelCount / bitDepth are rejected, no file created
test('validation: invalid sampleRate, channelCount, bitDepth throw RangeError', async () =>
{
    const badRates = [0, -1, 44100.5, NaN, Infinity, '44100', 2**32];
    const badChannels = [0, -2, 1.5, NaN, '2', 65536];
    const badDepths = [0, 8, 32, 16.5, NaN, '16'];
    let count = 0;
    for (const sampleRate of badRates)
        await assert.rejects(
            wav.createWavWriter(join(tmp, `bad-${count++}.wav`), {sampleRate, channelCount: 2}),
            RangeError, `sampleRate ${sampleRate}`);
    for (const channelCount of badChannels)
        await assert.rejects(
            wav.createWavWriter(join(tmp, `bad-${count++}.wav`), {sampleRate: 44100, channelCount}),
            RangeError, `channelCount ${channelCount}`);
    for (const bitDepth of badDepths)
        await assert.rejects(
            wav.createWavWriter(join(tmp, `bad-${count++}.wav`), {sampleRate: 44100, channelCount: 2, bitDepth}),
            RangeError, `bitDepth ${bitDepth}`);
    // no files were created for any rejected configuration
    for (let i = 0; i < count; ++i)
        assert.ok(!existsSync(join(tmp, `bad-${i}.wav`)), `bad-${i}.wav should not exist`);
    // boundary values are accepted
    const ok = await wav.createWavWriter(join(tmp, 'ok.wav'), {sampleRate: 1, channelCount: 1, bitDepth: 16});
    await ok.write([new Float32Array([0.5])]);
    await ok.end();
});

// 5. failure paths delete the partial file
test('failure: mid-stream invalid chunk deletes partial file', async () =>
{
    const path = join(tmp, 'fail-chunk.wav');
    const writer = await wav.createWavWriter(path, {sampleRate: 44100, channelCount: 2});
    await writer.write([new Float32Array(100), new Float32Array(100)]);
    assert.ok(existsSync(path));
    await assert.rejects(writer.write([new Float32Array(100)]), TypeError); // wrong channel count
    assert.ok(!existsSync(path), 'partial file was not deleted');
    await assert.rejects(writer.write([new Float32Array(1), new Float32Array(1)])); // stays failed
});

test('failure: mid-stream length mismatch deletes partial file', async () =>
{
    const path = join(tmp, 'fail-length.wav');
    const writer = await wav.createWavWriter(path, {sampleRate: 44100, channelCount: 2});
    await writer.write([new Float32Array(100), new Float32Array(100)]);
    await assert.rejects(writer.write([new Float32Array(100), new Float32Array(50)]), TypeError);
    assert.ok(!existsSync(path), 'partial file was not deleted');
});

test('failure: abort() deletes partial file', async () =>
{
    const path = join(tmp, 'fail-abort.wav');
    const writer = await wav.createWavWriter(path, {sampleRate: 44100, channelCount: 2});
    await writer.write([new Float32Array(1000), new Float32Array(1000)]);
    assert.ok(existsSync(path));
    await writer.abort();
    assert.ok(!existsSync(path), 'partial file was not deleted after abort()');
    await assert.rejects(writer.write([new Float32Array(1), new Float32Array(1)]), /aborted/);
    await assert.rejects(writer.end(), /aborted/);
});

test('failure: unwritable destination surfaces I/O error and cleans up', async () =>
{
    // open failure: directory does not exist
    const missing = join(tmp, 'no-such-dir', 'x.wav');
    await assert.rejects(wav.createWavWriter(missing, {sampleRate: 44100, channelCount: 2}), /ENOENT/);
    assert.ok(!existsSync(missing));

    // write failure: /dev/full always fails with ENOSPC (Linux)
    if (existsSync('/dev/full'))
    {
        await assert.rejects(
            wav.createWavWriter('/dev/full', {sampleRate: 44100, channelCount: 2}),
            (e) => e.code === 'ENOSPC');
    }
});

test('usage: end() twice and write() after end() throw', async () =>
{
    const path = join(tmp, 'usage.wav');
    const writer = await wav.createWavWriter(path, {sampleRate: 44100, channelCount: 2});
    await writer.write([new Float32Array([0.1, 0.2]), new Float32Array([0.3, 0.4])]);
    const info = await writer.end();
    assert.equal(info.sampleFrames, 2);
    assert.equal(info.fileBytes, 46 + 2*2*2);
    assert.equal(statSync(path).size, info.fileBytes);
    await assert.rejects(writer.end(), /already/);
    await assert.rejects(writer.write([new Float32Array(1), new Float32Array(1)]), /after end/);
    assert.ok(existsSync(path), 'finished file must survive');
});

// 6. 3 minute material: one-shot vs streamed byte identity
test('3 minute material: one-shot and streamed files are byte identical', async () =>
{
    const sampleRate = 48000, channelCount = 2, seconds = 180;
    const sampleCount = sampleRate * seconds; // 8.64M frames per channel
    const channels = makeChannels(channelCount, sampleCount, 42);

    const oneShot = Buffer.from(wav.buildWavBytes(channels, sampleRate));
    const path = join(tmp, 'three-minutes.wav');
    const info = await streamToFile(path, channels, {sampleRate, channelCount, bitDepth: 16}, sampleRate / 4);
    const streamed = readFileSync(path);

    const oneShotHash = sha256(oneShot), streamedHash = sha256(streamed);
    console.log(`    3min 48kHz stereo 16-bit: ${info.fileBytes} bytes`);
    console.log(`    one-shot sha256: ${oneShotHash}`);
    console.log(`    streamed sha256: ${streamedHash}`);
    assert.equal(streamedHash, oneShotHash, '3 minute files differ');
    assert.ok(streamed.equals(oneShot));
    assert.equal(info.fileBytes, 46 + 2 * channelCount * sampleCount);
});

// run
let failed = 0;
for (const [name, fn] of tests)
{
    try
    {
        await fn();
        console.log(`ok   - ${name}`);
    }
    catch (error)
    {
        failed = 1;
        console.error(`FAIL - ${name}`);
        console.error(error);
    }
}
rmSync(tmp, {recursive: true, force: true});
if (failed)
    process.exit(1);
console.log(`${tests.length} tests passed`);
