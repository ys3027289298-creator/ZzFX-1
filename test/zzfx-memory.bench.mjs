// Memory and sample-exactness benchmark for the chunked streaming path.
// Run with: node --expose-gc test/zzfx-memory.bench.mjs
// Each measurement happens in its own child process so V8 heap baselines
// never mix the one-shot and streaming runs.

import {spawn} from 'child_process';
import {fileURLToPath} from 'url';
import {dirname, resolve} from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(here, 'zzfx-memory-worker.lib.mjs');

// long, looping sound: ~60s at 44.1kHz = 2,646,009 samples,
// with a 0.5s repeatTime loop, 0.5s delay echo and an active filter
export const longSound =
    [1, 0, 220, .2, 50, 8, 2, 1, 0.2, 0.05, 120, .5, .5, .2, .3, 2, .5, 1, .2, .3];

const modes = [
    {name: 'one-shot buildSamples (before-equivalent)', mode: 'oneshot'},
    {name: 'stream chunkSize=1024  (discard chunks)', mode: 'stream', chunkSize: 1024, keep: false},
    {name: 'stream chunkSize=16384 (discard chunks)', mode: 'stream', chunkSize: 16384, keep: false},
    {name: 'stream chunkSize=262144(discard chunks)', mode: 'stream', chunkSize: 262144, keep: false},
    {name: 'stream chunkSize=1024  (reassemble full)', mode: 'stream', chunkSize: 1024, keep: true}
];

function run(cfg)
{
    return new Promise((resolvePromise, reject) =>
    {
        const child = spawn(process.execPath,
            ['--expose-gc', workerPath, JSON.stringify({...cfg, params: longSound})],
            {stdio: ['ignore', 'pipe', 'pipe']});
        let out = '', err = '';
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        child.on('close', code =>
        {
            if (code != 0)
                reject(new Error('worker failed: ' + err));
            else
                resolvePromise(JSON.parse(out.trim().split('\n').at(-1)));
        });
    });
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }

// theoretical sample-array memory bound
function theoreticalBounds()
{
    const sr = 44100;
    const params = longSound;
    const attack = params[3] * sr || 9;
    const decay = params[18] * sr;
    const sustain = params[4] * sr;
    const release = params[5] * sr;
    const delay = params[16] * sr;
    const length = (attack + decay + sustain + release + delay) | 0;
    const ringLength = delay ? Math.ceil(delay) : 0;
    return {length, ringLength};
}

async function main()
{
    console.log('ZzFX streaming memory benchmark (each row is a fresh process)');
    console.log('input:', JSON.stringify(longSound));
    const {length, ringLength} = theoreticalBounds();
    console.log('sound length:', length, 'samples =', mb(length * 4),
        '| delay ring:', ringLength, 'samples =', mb(ringLength * 4));
    console.log('');
    const rows = [];
    for (const cfg of modes)
    {
        const r = await run(cfg);
        rows.push({...cfg, ...r});
        console.log(
            cfg.name.padEnd(46),
            'samples=' + String(r.samplesEmitted).padStart(8),
            'peakHeap=' + mb(r.heapBefore + r.heapDelta).padStart(9),
            'rss=' + mb(r.rssPeak).padStart(9),
            'retained=' + mb(r.retainedBytes).padStart(9),
            'mismatch=' + r.mismatch,
            'checksum=' + r.checksum.toFixed(6)
        );
    }

    const oneshot = rows.find(r => r.mode === 'oneshot');
    const reassemble = rows.find(r => r.mode === 'stream' && r.keep);
    console.log('');
    console.log('checks:');
    console.log('  sample counts identical :',
        rows.every(r => r.samplesEmitted === oneshot.samplesEmitted));
    console.log('  checksums identical      :',
        new Set(rows.map(r => r.checksum.toFixed(9))).size === 1);
    console.log('  bit-exact mismatches     :', reassemble.mismatch);
    const discard = rows.filter(r => r.mode === 'stream' && !r.keep);
    console.log('  streaming heap growth independent of total length;');
    console.log('  discard-mode max heapGrowth =',
        mb(Math.max(...discard.map(r => r.heapDelta))));
    console.log('  one-shot full Float32Array  =',
        mb(oneshot.samplesEmitted * 4), '=', oneshot.samplesEmitted, 'samples * 4 bytes');
    console.log('');
    console.log('theoretical per-stream sample-array bound (excluding V8/engine):');
    for (const chunkSize of [1024, 16384, 262144])
    {
        const bound = (chunkSize + ringLength) * 4;
        console.log('  chunkSize=' + String(chunkSize).padEnd(8),
            'max live samples = chunk + delay ring =',
            chunkSize + ringLength, '=>', mb(bound));
    }
    console.log('  one-shot bound =', length, 'samples * 4 =', mb(length * 4));
}

main().catch(e => { console.error(e); process.exit(1); });
