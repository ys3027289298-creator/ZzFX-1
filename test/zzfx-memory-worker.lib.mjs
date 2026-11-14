// Child-process worker for zzfx-memory.bench.mjs. Runs one measurement per
// process so heap baselines stay isolated between one-shot and stream modes.
import {argv} from 'process';

// when the test runner opens this file directly there is no JSON config
if (argv.length < 3 || !argv[2].startsWith('{'))
    process.exit(0);

import {readFileSync} from 'fs';
import {resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

globalThis.AudioContext = class
{
    createBuffer(channelCount, length)
    {
        return {getChannelData: () => new Float32Array(length)};
    }
    createBufferSource() { return {connect(){ return this; }, start(){}}; }
    createGain() { return {connect(){}, gain: {}}; }
};
globalThis.StereoPannerNode = class { connect(node) { return node; } };

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(resolve(here, '../ZzFX.js'), 'utf8');
const {ZZFX} = await import(
    'data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const cfg = JSON.parse(process.argv[2]);
Math.random = () => 0.424242;

global.gc();
const heapBefore = process.memoryUsage().heapUsed;
const rssBefore = process.memoryUsage().rss;
let peakHeap = heapBefore;
let samplesEmitted = 0;
let mismatch = 0;
let checksum = 0;
let kept = null;

if (cfg.mode === 'oneshot')
{
    const all = ZZFX.buildSamples(...cfg.params);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    samplesEmitted = all.length;
    for (let i = 0; i < all.length; ++i)
        checksum += all[i];
    kept = all;
}
else
{
    const stream = ZZFX.buildSamplesStream(cfg.chunkSize, ...cfg.params);
    if (cfg.keep)
        kept = new Float32Array(stream.length);
    let offset = 0;
    let result;
    while (!(result = stream.next()).done)
    {
        const chunk = result.value;
        for (let i = 0; i < chunk.length; ++i)
            checksum += chunk[i];
        if (cfg.keep)
        {
            kept.set(chunk, offset);
            offset += chunk.length;
        }
        samplesEmitted += chunk.length;
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
}

if (cfg.mode === 'stream' && cfg.keep)
{
    Math.random = () => 0.424242;
    const reference = ZZFX.buildSamples(...cfg.params);
    for (let i = 0; i < reference.length; ++i)
        if (!Object.is(reference[i], kept[i]))
            ++mismatch;
}

global.gc();
const after = process.memoryUsage();
console.log(JSON.stringify({
    samplesEmitted,
    mismatch,
    checksum,
    heapBefore,
    retainedBytes: kept ? kept.byteLength : 0,
    heapDelta: peakHeap - heapBefore,
    rssPeak: after.rss,
    rssDelta: after.rss - rssBefore
}));
