// Generates test/fixtures/baseline.json from the pristine ZzFX.js at the
// current git HEAD. The engine file is never modified by the effects work,
// so this baseline is the "before" reference for bit-exactness checks.

import {createHash} from 'node:crypto';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import './stub-web-audio.mjs';
import {ZZFX} from '../ZzFX.js';

const sha256 = floatArray =>
{
    const bytes = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
    return createHash('sha256').update(bytes).digest('hex');
};

const peakOf = floatArray =>
{
    let peak = 0;
    for (const v of floatArray)
    {
        const a = Math.abs(v);
        if (a > peak) peak = a;
    }
    return peak;
};

// randomness (2nd parameter) is 0 everywhere, so buildSamples is deterministic
export const BASELINE_INPUTS =
[
    [1, 0, 440, 0.01, 0, 0.15, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0.05, 0, 0],
    [1, 0, 537, 0.02, 0.02, 0.22, 1, 1.59, -6.98, 4.97, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    [1.5, 0, 270, 0, 0, 0, 1, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.01, 0, 0, 0],
    [1, 0, 129, 0.01, 0, 0.15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 1, 0, 0, 0]
];

const sha = execSync('git rev-parse HEAD', {cwd:process.cwd()}).toString().trim();
const fixture =
{
    generatedAt: new Date().toISOString(),
    sampleRate: ZZFX.sampleRate,
    engineGitSha: sha,
    inputs: BASELINE_INPUTS.map((params, index) =>
    {
        const samples = ZZFX.buildSamples(...params);
        return {
            index,
            params,
            sampleCount: samples.length,
            peak: peakOf(samples),
            sha256: sha256(samples)
        };
    })
};

const outPath = new URL('./fixtures/baseline.json', import.meta.url);
mkdirSync(dirname(fileURLToPath(outPath)), {recursive:true});
writeFileSync(fileURLToPath(outPath), JSON.stringify(fixture, null, 1) + '\n');
console.log(`wrote ${fixture.inputs.length} baselines from ZzFX.js @ ${sha}`);
for (const b of fixture.inputs)
    console.log(`  input ${b.index}: ${b.sampleCount} samples, peak ${b.peak}, ${b.sha256.slice(0,16)}...`);
