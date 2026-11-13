// Check 1 (hard requirement): the modified engine must reproduce the ORIGINAL
// engine's 44.1k output sample-for-sample (bit-identical Float32 values).
'use strict';

import './polyfills.mjs';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {sounds} from './sounds.mjs';
import {ZZFX} from './ZzFX-link.js';

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, 'golden-44100.json'), 'utf8'));

function installSeededRandom(seed = 1234567)
{
    let state = seed >>> 0;
    Math.random = () =>
    {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

let failures = 0;
for (const {name, params, seeded} of sounds)
{
    if (seeded) installSeededRandom();
    const got = ZZFX.buildSamples(...params);
    const ref = new Float32Array(golden[name].samples);
    const sameLength = got.length === ref.length;
    let firstDiff = -1;
    const n = Math.min(got.length, ref.length);
    for (let i = 0; i < n; i++)
    {
        if (got[i] !== ref[i]) { firstDiff = i; break; }
    }
    const ok = sameLength && firstDiff < 0;
    if (!ok) failures++;
    console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} ` +
        `len ${got.length}/${ref.length}` +
        (firstDiff >= 0 ? `  first diff @${firstDiff}: got ${got[firstDiff]} ref ${ref[firstDiff]}` : '')
    );
}

console.log(failures ? `\n${failures} sound(s) differ from golden output` : '\nall outputs bit-identical to original 44.1k engine');
process.exitCode = failures ? 1 : 0;
