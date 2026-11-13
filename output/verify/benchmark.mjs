// Render-time comparison at 44.1k and 48k using the repo's own buildSamples
// entry point. Runs each sound many times and reports total/mean time plus
// the expected sample-count scaling.
'use strict';

import './polyfills.mjs';
import {ZZFX} from './ZzFX-link.js';
import {sounds} from './sounds.mjs';

const RATES = [44100, 48000];
const ITERATIONS = 400;
const ROUNDS = 5;

function renderAt(params, rate)
{
    const filled = params.slice();
    while (filled.length < 21) filled.push(undefined);
    return ZZFX.buildSamples(...filled, rate);
}

function benchOnce(rate)
{
    const start = process.hrtime.bigint();
    let totalSamples = 0;
    for (let iter = 0; iter < ITERATIONS; iter++)
        for (const {params} of sounds)
            totalSamples += renderAt(params, rate).length;
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {rate, elapsedMs, totalSamples};
}

// warm up both rates so JIT/allocator state is steady
for (const rate of RATES)
    for (const {params} of sounds) renderAt(params, rate);

// alternate rate order each round to remove ordering bias, take the median
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
const collected = Object.fromEntries(RATES.map(r => [r, []]));
for (let round = 0; round < ROUNDS; round++)
{
    const order = round % 2 ? [...RATES].reverse() : RATES;
    for (const rate of order) collected[rate].push(benchOnce(rate));
}

const results = RATES.map(rate => ({
    rate,
    elapsedMs: median(collected[rate].map(r => r.elapsedMs)),
    totalSamples: median(collected[rate].map(r => r.totalSamples)),
}));
const [r44, r48] = results;

const rows = results.map(r => ({
    sampleRate: r.rate,
    totalMs: r.elapsedMs.toFixed(2),
    perSoundMs: (r.elapsedMs / (ITERATIONS * sounds.length)).toFixed(4),
    samplesPerCall: Math.round(r.totalSamples / (ITERATIONS * sounds.length)),
    nsPerSample: (r.elapsedMs * 1e6 / r.totalSamples).toFixed(2),
}));

console.table(rows);
console.log(`time ratio 48k/44.1k: ${(r48.elapsedMs / r44.elapsedMs).toFixed(3)}`);
console.log(`sample-count ratio:  ${(r48.totalSamples / r44.totalSamples).toFixed(3)} (expected ${(48000/44100).toFixed(3)})`);

// emit machine-readable summary for the report
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'benchmark.json'), JSON.stringify({
    iterations: ITERATIONS,
    sounds: sounds.length,
    rows,
    timeRatio: r48.elapsedMs / r44.elapsedMs,
    sampleRatio: r48.totalSamples / r44.totalSamples,
}, null, 2));
