// Generate golden reference output from the ORIGINAL engine (output/ref/ZzFX.orig.js)
// at its fixed 44.1k sample rate.
'use strict';

import './polyfills.mjs';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {sounds} from './sounds.mjs';
import {ZZFX} from './ZzFX-orig-link.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = {};

// deterministic PRNG so randomness-path comparisons are reproducible
function installSeededRandom(seed = 1234567)
{
    let state = seed >>> 0;
    Math.random = () =>
    {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

for (const {name, params, seeded} of sounds)
{
    if (seeded) installSeededRandom();
    const samples = ZZFX.buildSamples(...params);
    golden[name] = {sampleRate: ZZFX.sampleRate, length: samples.length, samples: Array.from(samples)};
}

writeFileSync(join(here, 'golden-44100.json'), JSON.stringify(golden));
console.log(`golden written for ${Object.keys(golden).length} sounds @ ${ZZFX.sampleRate} Hz`);
