// Full verification for ZzFXEffects. Writes artifacts/verify-results.json.
// Run one failure case with: node test/run-verify.mjs --case=<id>

import {writeFileSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import './stub-web-audio.mjs';
import {ZZFX} from '../ZzFX.js';
import {applyEffects, getBufferPlan, getPeakBound, ZzFXEffectsError, ZZFX_EFFECT_LIMITS} from '../ZzFXEffects.js';
import {sha256, peakOf, allFinite, measuredTailMs, impulseTapPeaks} from './verify-helpers.mjs';

const baseline = JSON.parse(readFileSync(
    fileURLToPath(new URL('./fixtures/baseline.json', import.meta.url)), 'utf8'));

const R = ZZFX.sampleRate;
const args = process.argv.slice(2);
const onlyCase = (args.find(a => a.startsWith('--case=')) || '').split('=')[1];
const results = {generatedAt:new Date().toISOString(), sampleRate:R,
    baselineSource:`pristine ZzFX.js @ ${baseline.engineGitSha}, test/fixtures/baseline.json`};

const dryBuffers = baseline.inputs.map(b => ZZFX.buildSamples(...b.params));
const mainParams = baseline.inputs[0].params;
const mainDry = dryBuffers[0];

const EFFECTS_ON =
{
    delayTime:.2, delayFeedback:.6, delayMix:.3,
    reverbTail:.8, reverbMix:.25
};

///////////////////////////////////////////////////////////////////////////////
// 1. before/after comparison on the same input
{
    const off = applyEffects(mainDry, {...EFFECTS_ON, delayMix:0, reverbMix:0});
    const on = applyEffects(mainDry, EFFECTS_ON);
    results.comparison =
    {
        input: mainParams,
        baseline:
        {
            samples: mainDry.length,
            peak: peakOf(mainDry),
            sha256: sha256(mainDry)
        },
        effectsOff:
        {
            samples: off.length,
            peak: peakOf(off),
            sha256: sha256(off)
        },
        effectsOn:
        {
            options: EFFECTS_ON,
            samples: on.length,
            peak: peakOf(on),
            sha256: sha256(on)
        },
        differingSamples: off === mainDry ? 0 :
            off.filter((v, i) => v !== mainDry[i]).length,
        pass: sha256(off) === sha256(mainDry) && allFinite(on)
    };
}

///////////////////////////////////////////////////////////////////////////////
// 2. bit-exact old behavior for every "inactive" option shape
{
    const shapes = name =>
    ({
        'omitted': undefined,
        'null': null,
        'empty object': {},
        'zero delayTime': {delayTime:0},
        'zero delayMix': {delayTime:.2, delayMix:0},
        'all zero': {delayTime:0, delayFeedback:0, delayMix:0, reverbTail:0, reverbMix:0},
        'zero reverbMix': {reverbTail:.5, reverbMix:0}
    })[name];
    const shapeNames = ['omitted','null','empty object','zero delayTime',
        'zero delayMix','all zero','zero reverbMix'];
    const checks = [];
    for (let i = 0; i < dryBuffers.length; ++i)
    {
        for (const shape of shapeNames)
        {
            const out = applyEffects(dryBuffers[i], shapes(shape));
            checks.push({
                input:i, shape,
                sameReference: out === dryBuffers[i],
                bitExact: sha256(out) === baseline.inputs[i].sha256
            });
        }
    }
    results.exactness =
    {
        inputCount: dryBuffers.length,
        shapeCount: shapeNames.length,
        totalChecks: checks.length,
        pass: checks.every(c => c.sameReference && c.bitExact),
        checks
    };
}

///////////////////////////////////////////////////////////////////////////////
// 3. failure paths
class InstanceMarker {}
const failureCases =
[
    ['e1-number', 1, () => applyEffects(mainDry, 42)],
    ['e1-string', 1, () => applyEffects(mainDry, 'reverb')],
    ['e1-array', 1, () => applyEffects(mainDry, [])],
    ['e1-class-instance', 1, () => applyEffects(mainDry, new InstanceMarker())],
    ['e2-negative', 2, () => applyEffects(mainDry, {delayTime:-.1})],
    ['e2-cap', 2, () => applyEffects(mainDry, {delayTime:1.0001})],
    ['e2-nan', 2, () => applyEffects(mainDry, {delayTime:NaN})],
    ['e2-infinity', 2, () => applyEffects(mainDry, {delayTime:Infinity})],
    ['e3-negative', 3, () => applyEffects(mainDry, {delayTime:.2, delayFeedback:-.1})],
    ['e3-limit', 3, () => applyEffects(mainDry, {delayTime:.2, delayFeedback:.95})],
    ['e3-cap', 3, () => applyEffects(mainDry, {delayTime:.2, delayFeedback:1})],
    ['e4-negative', 4, () => applyEffects(mainDry, {delayTime:.2, delayMix:-.1})],
    ['e4-cap', 4, () => applyEffects(mainDry, {delayTime:.2, delayMix:1.0001})],
    ['e5-tail-cap', 5, () => applyEffects(mainDry, {reverbTail:2.0001, reverbMix:.5})],
    ['e5-tail-negative', 5, () => applyEffects(mainDry, {reverbTail:-.1, reverbMix:.5})],
    ['e5-mix-zero-tail', 5, () => applyEffects(mainDry, {reverbTail:0, reverbMix:.5})],
    ['e6-mix-cap', 6, () => applyEffects(mainDry, {reverbTail:.5, reverbMix:1.0001})],
    ['e6-nan', 6, () => applyEffects(mainDry, {reverbTail:.5, reverbMix:NaN})],
    ['e7-unknown', 7, () => applyEffects(mainDry, {unknownKnob:1})],
    ['e8-empty', 8, () => applyEffects(new Float32Array(0), {delayTime:.2, delayMix:.3})],
    ['e8-array', 8, () => applyEffects([1, 2, 3], {delayTime:.2, delayMix:.3})],
    ['e9-feedback', 9, () => applyEffects(mainDry, {delayFeedback:.5})],
    ['e9-mix', 9, () => applyEffects(mainDry, {delayMix:.5})],
    ['e10-non-finite-input', 10, () =>
    {
        const bad = new Float32Array(mainDry);
        bad[10] = NaN;
        return applyEffects(bad, {delayTime:.2, delayMix:.3});
    }]
];
{
    const checks = [];
    for (const [id, expectedNumber, fn] of failureCases)
    {
        if (onlyCase && id !== onlyCase) continue;
        let observed = null;
        try
        {
            fn();
        }
        catch (e)
        {
            observed = e instanceof ZzFXEffectsError ? e.code : `non-ZzFXEffectsError:${e.name}`;
        }
        const expected = `ZZFX_E${expectedNumber}`;
        checks.push({id, expected, observed, pass: observed === expected});
    }
    results.failurePaths =
    {
        count: checks.length,
        pass: checks.every(c => c.pass),
        checks
    };
}

///////////////////////////////////////////////////////////////////////////////
// 4. three parameter sets: tail duration, peaks, no divergence
const TAIL_SETS =
[
    {id:'A', label:'gentle slap echo + small room',
        options:{delayTime:.18, delayFeedback:.35, delayMix:.25, reverbTail:.4, reverbMix:.2}},
    {id:'B', label:'medium room echo + hall',
        options:{delayTime:.2, delayFeedback:.6, delayMix:.3, reverbTail:.8, reverbMix:.25}},
    {id:'C', label:'long resonant echo + large hall',
        options:{delayTime:.13, delayFeedback:.72, delayMix:.35, reverbTail:1.5, reverbMix:.3}}
];
{
    const checks = TAIL_SETS.map(({id, label, options}) =>
    {
        const plan = getBufferPlan(mainDry.length, options);
        const rendered = applyEffects(mainDry, options);
        const {taps} = impulseTapPeaks(applyEffects, options, mainDry.length, R);
        const peakBound = getPeakBound(options).bound;
        const dryPeak = peakOf(mainDry);

        // wet tap ratios must equal the configured feedback (geometric decay)
        const ratios = [];
        for (let i = 2; i < taps.length; ++i)
            ratios.push(taps[i] / taps[i - 1]);
        const maxTapRatio = ratios.length ? Math.max(...ratios) : 0;
        const decays = taps.slice(1).every((v, i) => v <= taps[i] + 1e-7);

        // echo count from the geometric tap amplitude vs the -80 dB floor
        const wetAmplitudes = taps.slice(1);
        const naturalEchoes = wetAmplitudes.filter(v => v > ZZFX_EFFECT_LIMITS.tailThreshold).length;
        const capEchoes = Math.floor(ZZFX_EFFECT_LIMITS.maxDelayTailSeconds / options.delayTime);

        return {
            id, label, options,
            naturalEchoes, capEchoes, capped: plan.audibleTaps * plan.delaySamples >
                ZZFX_EFFECT_LIMITS.maxDelayTailSeconds * R,
            delayAllocatedMs: plan.delayTailSamples * 1000 / R,
            allocatedTailMs: (plan.delayTailSamples + plan.reverbTailSamples) * 1000 / R,
            measuredTailMs: measuredTailMs(rendered, mainDry.length, R),
            overallPeak: peakOf(rendered),
            tailPeak: peakOf(rendered.subarray(mainDry.length)),
            finite: allFinite(rendered),
            dryPeak,
            analyticPeakBound: peakBound,
            withinBound: peakOf(rendered) <= peakBound * dryPeak + 1e-6,
            impulseTapPeaks: taps,
            maxTapRatio,
            decays,
            pass: allFinite(rendered) && decays &&
                maxTapRatio <= options.delayFeedback + 1e-6 &&
                peakOf(rendered) <= peakBound * dryPeak + 1e-6
        };
    });
    results.tailSets = {threshold:ZZFX_EFFECT_LIMITS.tailThreshold,
        pass: checks.every(c => c.pass), checks};
}

///////////////////////////////////////////////////////////////////////////////
// 5. boundary stress: feedback 0.94, 1 s delay, mix 0.5
{
    const options = {delayTime:1, delayFeedback:.94, delayMix:.5};
    const plan = getBufferPlan(mainDry.length, options);
    const {taps, rendered} = impulseTapPeaks(applyEffects, options, mainDry.length, R);
    const peakBound = getPeakBound(options).bound;
    results.stress =
    {
        options,
        finite: allFinite(rendered),
        overallPeak: peakOf(rendered),
        analyticPeakBound: peakBound,
        withinBound: peakOf(rendered) <= peakBound + 1e-6,
        firstEchoPeak: taps[1],
        allocatedTailMs: plan.delayTailSamples * 1000 / R,
        withinCap: plan.delayTailSamples <=
            ZZFX_EFFECT_LIMITS.maxDelayTailSeconds * R,
        echoCount: taps.length - 1,
        monotonicDecay: taps.slice(1).every((v, i) => v <= taps[i] + 1e-7),
        impulseTapPeaks: taps,
        pass: allFinite(rendered) &&
            plan.delayTailSamples <= ZZFX_EFFECT_LIMITS.maxDelayTailSeconds * R &&
            peakOf(rendered) <= peakBound + 1e-6
    };
}

///////////////////////////////////////////////////////////////////////////////
// 6. reverb-only and serial delay + reverb
{
    const cases =
    [
        ['reverb only', {reverbTail:.8, reverbMix:.25}],
        ['delay + reverb', EFFECTS_ON],
        ['hot mix', {delayTime:.2, delayFeedback:.6, delayMix:1, reverbTail:1, reverbMix:1}]
    ];
    const checks = cases.map(([name, options]) =>
    {
        const plan = getBufferPlan(mainDry.length, options);
        const rendered = applyEffects(mainDry, options);
        const bound = getPeakBound(options).bound * peakOf(mainDry);
        return {
            name,
            allocatedTailMs: (plan.delayTailSamples + plan.reverbTailSamples) * 1000 / R,
            measuredTailMs: measuredTailMs(rendered, mainDry.length, R),
            peak: peakOf(rendered),
            analyticPeakBound: bound,
            withinBound: peakOf(rendered) <= bound + 1e-6,
            finite: allFinite(rendered)
        };
    });
    results.reverb = {pass: checks.every(c => c.finite && c.withinBound), checks};
}

///////////////////////////////////////////////////////////////////////////////
// 7. resource / memory upper bounds
{
    const worst = {delayTime:1, delayFeedback:.949999, delayMix:1,
        reverbTail:2, reverbMix:1};
    const plan = getBufferPlan(mainDry.length, worst);
    const predictedEffectSamples = plan.allocations.reduce((n, a) => n + a.samples, 0);
    const rendered = applyEffects(mainDry, worst);
    const measuredOutputSamples = rendered.length;
    results.memory =
    {
        dryInputSamples: mainDry.length,
        worstCaseOptions: worst,
        outputSamples: plan.outputSamples,
        maxDelayRingSamples: ZZFX_EFFECT_LIMITS.maxDelayTimeSeconds * R,
        maxDelayTailSamples: ZZFX_EFFECT_LIMITS.maxDelayTailSeconds * R,
        maxReverbTailSamples: ZZFX_EFFECT_LIMITS.maxReverbTailSeconds * R,
        allocations: plan.allocations,
        predictedEffectSamples,
        predictedEffectBytes: predictedEffectSamples * 4,
        measuredOutputSamples,
        accountingMatches: measuredOutputSamples === plan.outputSamples,
        totalBytesIncludingDry: (predictedEffectSamples + mainDry.length) * 4,
        maxTotalTailSeconds:
            ZZFX_EFFECT_LIMITS.maxDelayTailSeconds + ZZFX_EFFECT_LIMITS.maxReverbTailSeconds
    };
}

results.allPassed =
    results.comparison.pass &&
    results.exactness.pass &&
    results.failurePaths.pass &&
    results.tailSets.pass &&
    results.stress.pass &&
    results.reverb.pass &&
    results.memory.accountingMatches;

const outPath = fileURLToPath(new URL('../artifacts/verify-results.json', import.meta.url));
writeFileSync(outPath, JSON.stringify(results, null, 1) + '\n');

for (const [name, value] of Object.entries(results))
{
    if (name === 'generatedAt' || name === 'sampleRate' || name === 'baselineSource') continue;
    const pass = name === 'memory' ? value.accountingMatches :
        name === 'allPassed' ? value : value.pass;
    console.log(`${name.padEnd(14)} ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(`\nallPassed: ${results.allPassed}`);
console.log(`wrote ${outPath}`);
process.exit(results.allPassed ? 0 : 1);
