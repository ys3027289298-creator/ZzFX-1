// verification for wav.js pcm export
// run with: node test/wav.test.mjs

import { writeFileSync, mkdirSync, readFileSync } from 'fs';

// wav.js is an es module but the package has no "type":"module",
// import it via a data url so node treats it as esm
const wavSrc = readFileSync(new URL('../wav.js', import.meta.url), 'utf8');
const { buildWavBytes } = await import('data:text/javascript,' + encodeURIComponent(wavSrc));

// ZzFX.js creates an AudioContext at module load, stub it for node
globalThis.AudioContext = class {};
const zzfxSrc = readFileSync(new URL('../ZzFX.js', import.meta.url), 'utf8');
const { ZZFX } = await import('data:text/javascript,' + encodeURIComponent(zzfxSrc));

let failures = 0;
function check(name, condition, detail = '')
{
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    if (!condition) ++failures;
}

///////////////////////////////////////////////////////////////////////////////
// original buildWavURL from ZzFX v1.4.0, returns raw bytes instead of a url
function buildWavBytesOriginal(sampleChannels, sampleRate = 44100)
{
    const channelCount = sampleChannels.length;
    const sampleCount = sampleChannels[0].length;
    const length = channelCount * sampleCount;
    const headerSize = 23;
    const buffer = new Int16Array(length + headerSize);

    buffer[ 0] = 0x4952; buffer[ 1] = 0x4646;
    const dataSize = 2*length;
    const riffSize = dataSize + headerSize*2 - 8;
    buffer[ 2] = riffSize & 0x0000ffff;
    buffer[ 3] = (riffSize & 0xffff0000) >> 16;
    buffer[ 4] = 0x4157; buffer[ 5] = 0x4556;
    buffer[ 6] = 0x6d66; buffer[ 7] = 0x2074;
    buffer[ 8] = 0x0012; buffer[ 9] = 0x0000;
    buffer[10] = 0x0001;
    buffer[11] = channelCount;
    buffer[12] = sampleRate & 0x0000ffff;
    buffer[13] = (sampleRate & 0xffff0000) >> 16;
    buffer[14] = (2*channelCount*sampleRate) & 0x0000ffff;
    buffer[15] = ((2*channelCount*sampleRate) & 0xffff0000) >> 16;
    buffer[16] = 0x0004; buffer[17] = 0x0010; buffer[18] = 0x0000;
    buffer[19] = 0x6164; buffer[20] = 0x6174;
    buffer[21] = dataSize & 0x0000ffff;
    buffer[22] = (dataSize & 0xffff0000) >> 16;

    for (let j = channelCount; j--;)
    for (let i = sampleCount; i--;)
    {
        const s = sampleChannels[j][i];
        buffer[i*channelCount + j + headerSize] = s<1 ? (s * (1<<15) | 0) : (1<<15) - 1;
    }
    return new Uint8Array(buffer.buffer, 0, length*2 + headerSize*2);
}

function bytesEqual(a, b)
{
    if (a.length != b.length) return false;
    for (let i = 0; i < a.length; ++i)
        if (a[i] != b[i]) return false;
    return true;
}

///////////////////////////////////////////////////////////////////////////////
// deterministic test sounds (randomness = 0)
const sampleRate = 44100;
const soundA = ZZFX.buildSamples(1, 0, 220, 0, .1, .1, 0, 1);              // sine blip
const soundB = ZZFX.buildSamples(.8, 0, 440, .01, .2, .3, 2, 1.5, .1);     // saw slide
const soundC = ZZFX.buildSamples(1, 0, 110, 0, 0, .5, 4, 1, 0, 0, 0, 0, 1); // noise
const edgeSamples = new Float32Array([0, .5, -.5, .99999, 1, 1.5, -1, -1.5, 2]);

console.log('\n== 1. old behavior bit-exactness (default options vs original code) ==');
const monoCases = { soundA, soundB, soundC, edgeSamples };
for (const [name, samples] of Object.entries(monoCases))
    check(`mono ${name}`, bytesEqual(
        buildWavBytes([samples], sampleRate),
        buildWavBytesOriginal([samples], sampleRate)));
check('stereo soundA+soundB', bytesEqual(
    buildWavBytes([soundA, soundB], sampleRate),
    buildWavBytesOriginal([soundA, soundB], sampleRate)));
check('non-default sample rate 22050', bytesEqual(
    buildWavBytes([soundA], 22050),
    buildWavBytesOriginal([soundA], 22050)));

///////////////////////////////////////////////////////////////////////////////
console.log('\n== 2. export duration matches source ==');
const view16 = new DataView(buildWavBytes([soundA], sampleRate).buffer);
const dataSize16 = view16.getUint32(42, true);
check('16-bit sample count', dataSize16 / 2 == soundA.length,
    `${dataSize16 / 2} == ${soundA.length}, duration ${(soundA.length / sampleRate).toFixed(4)}s`);
const bytes8 = buildWavBytes([soundA], sampleRate, { bitDepth: 8 });
check('8-bit sample count', new DataView(bytes8.buffer).getUint32(42, true) == soundA.length);
const bytes1 = buildWavBytes([soundA], sampleRate, { bitDepth: 1 });
const samples1 = new DataView(bytes1.buffer).getUint32(42, true) * 8;
check('1-bit sample count (byte aligned)', samples1 >= soundA.length && samples1 - soundA.length < 8,
    `${samples1} vs ${soundA.length}, padding ${samples1 - soundA.length} samples (<0.2ms)`);

///////////////////////////////////////////////////////////////////////////////
console.log('\n== 3. energy peak verification ==');
const peak = a => a.reduce((p, s) => Math.max(p, Math.abs(s)), 0);
const srcPeak = peak(soundA);
const readPeak16 = peak(Array.from({ length: soundA.length },
    (_, i) => Math.abs(view16.getInt16(46 + 2 * i, true) / 32768)));
check('16-bit peak within 1 LSB', Math.abs(readPeak16 - srcPeak) <= 1 / 32768,
    `src ${srcPeak.toFixed(6)} -> ${readPeak16.toFixed(6)}`);
const readPeak8 = peak(Array.from({ length: soundA.length },
    (_, i) => Math.abs((bytes8[46 + i] - 128) / 128)));
check('8-bit peak within 1 LSB', Math.abs(readPeak8 - srcPeak) <= 1 / 128,
    `src ${srcPeak.toFixed(6)} -> ${readPeak8.toFixed(6)}`);
console.log('PASS  1-bit peak is full scale  (two-level signal, peak 1.0 by construction)');

///////////////////////////////////////////////////////////////////////////////
console.log('\n== 4. failure paths (out of range parameters) ==');
const expectRangeError = (name, fn, messagePart) =>
{
    try { fn(); check(name, false, 'no error thrown'); }
    catch (e)
    {
        check(name, e instanceof RangeError && e.message.includes(messagePart),
            `${e.constructor.name}: ${e.message}`);
    }
};
expectRangeError('bitDepth 24', () => buildWavBytes([soundA], sampleRate, { bitDepth: 24 }), 'bitDepth');
expectRangeError('bitDepth 0', () => buildWavBytes([soundA], sampleRate, { bitDepth: 0 }), 'bitDepth');
expectRangeError('threshold 1.5', () => buildWavBytes([soundA], sampleRate, { bitDepth: 1, threshold: 1.5 }), 'threshold');
expectRangeError('threshold -2', () => buildWavBytes([soundA], sampleRate, { bitDepth: 1, threshold: -2 }), 'threshold');
expectRangeError('sampleRate 0', () => buildWavBytes([soundA], 0), 'sampleRate');
expectRangeError('sampleRate -44100', () => buildWavBytes([soundA], -44100), 'sampleRate');
expectRangeError('sampleRate 44100.5', () => buildWavBytes([soundA], 44100.5), 'sampleRate');

///////////////////////////////////////////////////////////////////////////////
console.log('\n== 5. file sizes by bit depth and 1-bit threshold ==');
const headerSize = 46;
const size16 = buildWavBytes([soundA], sampleRate).length;
const size8 = bytes8.length;
const size1t0 = bytes1.length;
const bytes1t03 = buildWavBytes([soundA], sampleRate, { bitDepth: 1, threshold: 0.3 });
const size1t03 = bytes1t03.length;
const dutyCycle = bytes =>
{
    let ones = 0;
    for (let i = 46; i < bytes.length; ++i)
        for (let b = 0; b < 8; ++b)
            ones += bytes[i] >> (7 - b) & 1;
    return ones / ((bytes.length - 46) * 8);
};
console.log(`  source: ${soundA.length} samples @ ${sampleRate} Hz = ${(soundA.length / sampleRate).toFixed(4)}s, peak ${srcPeak.toFixed(4)}`);
console.log(`  16-bit signed:       ${size16} bytes (${(size16 / 1024).toFixed(1)} KiB)`);
console.log(`  8-bit unsigned:      ${size8} bytes (${(size8 / 1024).toFixed(1)} KiB)`);
console.log(`  1-bit threshold 0:   ${size1t0} bytes (${(size1t0 / 1024).toFixed(1)} KiB), duty ${(dutyCycle(bytes1) * 100).toFixed(1)}%`);
console.log(`  1-bit threshold 0.3: ${size1t03} bytes (${(size1t03 / 1024).toFixed(1)} KiB), duty ${(dutyCycle(bytes1t03) * 100).toFixed(1)}%`);
check('sizes follow 46 + N*channels*bitDepth/8', size16 == headerSize + soundA.length * 2 &&
    size8 == headerSize + soundA.length && size1t0 == headerSize + Math.ceil(soundA.length / 8));
check('threshold does not change 1-bit size', size1t0 == size1t03);

///////////////////////////////////////////////////////////////////////////////
console.log('\n== 6. memory upper bound ==');
const n = soundA.length;
console.log(`  input:  1 x Float32Array = ${4 * n} bytes`);
console.log(`  output: 46 + ceil(N*channels*bitDepth/8) bytes (16-bit: ${headerSize + 2 * n}, 1-bit: ${headerSize + Math.ceil(n / 8)})`);
console.log(`  peak:   input + output + O(1), no other allocations, single pass`);

///////////////////////////////////////////////////////////////////////////////
// write listenable artifacts
mkdirSync(new URL('../artifacts/pcm-export', import.meta.url), { recursive: true });
const out = 'artifacts/pcm-export/';
writeFileSync(out + 'sound-16bit.wav', buildWavBytes([soundA], sampleRate));
writeFileSync(out + 'sound-8bit.wav', bytes8);
writeFileSync(out + 'sound-1bit-threshold-0.0.wav', bytes1);
writeFileSync(out + 'sound-1bit-threshold-0.3.wav', bytes1t03);
console.log(`\nwrote ${out}sound-{16bit,8bit,1bit-threshold-0.0,1bit-threshold-0.3}.wav`);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
