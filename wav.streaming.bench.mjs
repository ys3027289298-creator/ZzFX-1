// Memory benchmark: one-shot vs streaming WAV export on the same input.
// Run with: node wav.streaming.bench.mjs
//
// Material: 3 minutes, 48 kHz, stereo, deterministic PRNG samples.
// Each mode runs in a fresh child process so peak RSS is isolated:
//   oneshot-original - original buildWavURL from git HEAD (Int16Array + Blob)
//   oneshot          - refactored buildWavBytes (single Int16Array)
//   stream16         - createWavWriter, 16-bit, 0.25 s chunks
//   stream24         - createWavWriter, 24-bit, 0.25 s chunks

import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SECONDS = 180;
const FRAMES = SAMPLE_RATE * SECONDS; // 8.64M frames per channel
const CHUNK_FRAMES = SAMPLE_RATE / 4; // render 0.25 s per iteration

const root = new URL('.', import.meta.url).pathname;
const loadModule = (source) =>
    import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

// deterministic PRNG, same seed => identical input in every mode
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

const nextSample = mulberry32(42); // shared sequence, chunk size independent

const peakMB = () => process.resourceUsage().maxRSS / 1024;

async function run(mode)
{
    const baseline = peakMB();
    const started = performance.now();
    let outputBytes = 0;

    if (mode === 'oneshot-original' || mode === 'oneshot')
    {
        const source = mode === 'oneshot-original'
            ? execFileSync('git', ['-C', root, 'show', 'HEAD:wav.js'], {encoding: 'utf8'})
            : readFileSync(join(root, 'wav.js'), 'utf8');
        const wav = await loadModule(source);

        // materialize the whole 3 minute input in memory first
        const channels = Array.from({length: CHANNELS}, () => new Float32Array(FRAMES));
        for (let i = 0; i < FRAMES; ++i)
            for (let j = 0; j < CHANNELS; ++j)
                channels[j][i] = nextSample() * 2 - 1;

        if (mode === 'oneshot-original')
        {
            const url = wav.buildWavURL(channels, SAMPLE_RATE);
            outputBytes = (await (await fetch(url)).arrayBuffer()).byteLength;
            URL.revokeObjectURL(url);
        }
        else
        {
            outputBytes = wav.buildWavBytes(channels, SAMPLE_RATE).length;
        }
    }
    else // stream16 / stream24
    {
        const wav = await loadModule(readFileSync(join(root, 'wav.js'), 'utf8'));
        const bitDepth = mode === 'stream24' ? 24 : 16;
        const dir = mkdtempSync(join(tmpdir(), 'wav-stream-bench-'));
        const path = join(dir, 'out.wav');
        const writer = await wav.createWavWriter(path,
            {sampleRate: SAMPLE_RATE, channelCount: CHANNELS, bitDepth});

        // render chunk by chunk, only one small chunk alive at a time
        for (let start = 0; start < FRAMES; start += CHUNK_FRAMES)
        {
            const frames = Math.min(CHUNK_FRAMES, FRAMES - start);
            const chunk = Array.from({length: CHANNELS}, () => new Float32Array(frames));
            for (let i = 0; i < frames; ++i)
                for (let j = 0; j < CHANNELS; ++j)
                    chunk[j][i] = nextSample() * 2 - 1;
            await writer.write(chunk);
        }
        const info = await writer.end();
        outputBytes = statSync(path).size;
        if (outputBytes !== info.fileBytes)
            throw new Error('file size mismatch');
        rmSync(dir, {recursive: true, force: true});
    }

    const result = {
        mode,
        baselineMB: +baseline.toFixed(1),
        peakMB: +peakMB().toFixed(1),
        deltaMB: +(peakMB() - baseline).toFixed(1),
        outputMB: +(outputBytes / 1048576).toFixed(1),
        seconds: +((performance.now() - started) / 1000).toFixed(2),
    };
    console.log(JSON.stringify(result));
}

const mode = process.argv[2];
if (mode)
{
    await run(mode);
}
else
{
    // parent: run each mode in a fresh child process and print a table
    const modes = ['oneshot-original', 'oneshot', 'stream16', 'stream24'];
    console.log(`material: ${SECONDS}s, ${SAMPLE_RATE} Hz, ${CHANNELS} channels, deterministic PRNG input`);
    console.log('mode               baselineMB  peakMB  deltaMB  outputMB  seconds');
    for (const m of modes)
    {
        const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, m],
            {encoding: 'utf8', maxBuffer: 1 << 20});
        if (child.status !== 0)
        {
            console.error(`${m} failed:\n${child.stderr}`);
            process.exit(1);
        }
        const r = JSON.parse(child.stdout.trim().split('\n').pop());
        console.log(
            r.mode.padEnd(18) +
            String(r.baselineMB).padStart(10) +
            String(r.peakMB).padStart(8) +
            String(r.deltaMB).padStart(9) +
            String(r.outputMB).padStart(10) +
            String(r.seconds).padStart(9));
    }
}
