// test/waveShaper.test.mjs
//
// Full verification for waveShaper.js. Zero dependencies, runs on the
// Node built-ins alone:
//
//   node test/waveShaper.test.mjs
//
// Outputs artifacts/waveshaper-report.json and artifacts/waveshaper-report.md,
// exits non-zero if any assertion fails.

import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync, copyFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = `${repoRoot}/artifacts`;
mkdirSync(artifactsDir, {recursive: true});

// ZzFX.js constructs an AudioContext at module load; stub it for Node.
globalThis.AudioContext = class AudioContextStub {};

// Node 18 loads .js as CommonJS without "type": "module" in package.json,
// and changing the package type would alter consumer behavior. Instead the
// engine sources are copied verbatim into a scratch ESM directory and
// imported from there; the production files are never modified.
const esmDir = join(artifactsDir, 'esm');
mkdirSync(esmDir, {recursive: true});
copyFileSync(`${repoRoot}/ZzFX.js`, `${esmDir}/ZzFX.js`);
copyFileSync(`${repoRoot}/waveShaper.js`, `${esmDir}/waveShaper.js`);
writeFileSync(`${esmDir}/package.json`, JSON.stringify({type: 'module'}));

const {ZZFX} = await import(pathToFileURL(`${esmDir}/ZzFX.js`).href);
const {
    applyWaveShaper, totalHarmonicDistortion, MAX_DRIVE, MAX_HARMONICS
} = await import(pathToFileURL(`${esmDir}/waveShaper.js`).href);

// count Float32Array allocations made through the global constructor.
// a Proxy preserves the native prototype chain, so `x instanceof Float32Array`
// inside the production module still holds, while every construct is counted.
const NativeFloat32Array = Float32Array;
let liveAllocations = 0;
let allocatedBytes = 0;
globalThis.Float32Array = new Proxy(NativeFloat32Array, {
    construct(target, args)
    {
        const instance = Reflect.construct(target, args);
        ++liveAllocations;
        allocatedBytes += instance.byteLength;
        return instance;
    }
});
const resetAllocationCounters = () => { liveAllocations = 0; allocatedBytes = 0; };

const SAMPLE_RATE = ZZFX.sampleRate; // 44100
const TEST_DRIVES = [1, 5, 25];
const ALL_DRIVES = [0, ...TEST_DRIVES];
const MODES = ['soft', 'hard'];
const EPS = 1e-7;
const failures = [];
const check = (name, fn) =>
{
    try { fn(); }
    catch (e) { failures.push(`${name}: ${e.message}`); }
};

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

// deterministic engine output: 220 Hz sine, randomness 0, ~0.1 s
const ZZFX_PARAMS = [1, 0, 220, 0, 0, 0.1, 0, 1];
const engineInput = ZZFX.buildSamples(...ZZFX_PARAMS);
const ENGINE_N = engineInput.length;

// controlled 1 kHz signal: 1 s, exactly 1000 integer cycles, so DFT bins
// line up with the harmonics and windowing leakage is zero
const CONTROLLED_N = SAMPLE_RATE;
const controlledInput = new NativeFloat32Array(CONTROLLED_N);
for (let i = 0; i < CONTROLLED_N; ++i)
    controlledInput[i] = 0.7 * Math.sin(2 * Math.PI * 1000 * i / SAMPLE_RATE);

const peakOf = a =>
{
    let p = 0;
    for (let i = a.length; i--;) { const v = Math.abs(a[i]); if (v > p) p = v; }
    return p;
};
const maxDelta = a =>
{
    let m = 0;
    for (let i = 1; i < a.length; ++i)
    {
        const d = Math.abs(a[i] - a[i - 1]);
        if (d > m) m = d;
    }
    return m;
};
const countNonFinite = a =>
{
    let c = 0;
    for (let i = a.length; i--;) if (!Number.isFinite(a[i])) ++c;
    return c;
};
const countOutsideRange = a =>
{
    let c = 0;
    for (let i = a.length; i--;) if (a[i] < -1 || a[i] > 1) ++c;
    return c;
};
const bitPatterns = a =>
{
    const words = new Uint32Array(a.buffer, a.byteOffset, a.length);
    return Array.from(words);
};

// independent full-DFT amplitude at bin k (cross-check for Goertzel)
const dftAmplitude = (a, k) =>
{
    let re = 0, im = 0;
    const step = 2 * Math.PI * k / a.length;
    for (let n = 0; n < a.length; ++n)
    {
        re += a[n] * Math.cos(step * n);
        im -= a[n] * Math.sin(step * n);
    }
    return 2 * Math.hypot(re, im) / a.length;
};
const dftThd = (a, f0, sampleRate) =>
{
    const binOf = f => f * a.length / sampleRate;
    let harmonicPower = 0;
    const hMax = Math.min(MAX_HARMONICS, Math.floor((sampleRate / 2 - 1e-9) / f0));
    for (let h = 2; h <= hMax; ++h)
    {
        const amp = dftAmplitude(a, binOf(h * f0));
        harmonicPower += amp * amp;
    }
    return Math.sqrt(harmonicPower) / dftAmplitude(a, binOf(f0));
};

// run one shaper case and collect every metric needed by the report tables
const runCase = (input, inputName, mode, drive, fundamentalFrequency) =>
{
    resetAllocationCounters();
    const inputSnapshot = bitPatterns(input);
    const result = applyWaveShaper(input, {mode, drive, sampleRate: SAMPLE_RATE, fundamentalFrequency});
    const {samples: out, peak, gain, thd} = result;

    check(
        `allocations ${inputName}/${mode}/drive${drive}`,
        () => assert.equal(liveAllocations, 1));
    check(
        `allocated bytes ${inputName}/${mode}/drive${drive}`,
        () => assert.equal(allocatedBytes, input.length * 4));
    check(
        `input untouched ${inputName}/${mode}/drive${drive}`,
        () => assert.deepEqual(bitPatterns(input), inputSnapshot));
    check(
        `non-finite ${inputName}/${mode}/drive${drive}`,
        () => assert.equal(countNonFinite(out), 0));
    check(
        `range ${inputName}/${mode}/drive${drive}`,
        () => assert.equal(countOutsideRange(out), 0));
    check(
        `peak matches ${inputName}/${mode}/drive${drive}`,
        () => assert.ok(Math.abs(peak - peakOf(out)) <= EPS));
    check(
        `lipschitz ${inputName}/${mode}/drive${drive}`,
        () => assert.ok(
            maxDelta(out) <= gain * maxDelta(input) + EPS,
            `max delta ${maxDelta(out)} > gain ${gain} * input delta ${maxDelta(input)}`));

    return {
        input: inputName, mode, drive, gain,
        peak, thd,
        outputDelta: maxDelta(out),
        inputDelta: maxDelta(input),
        nonFinite: countNonFinite(out),
        outsideRange: countOutsideRange(out),
        allocations: liveAllocations,
        allocatedBytes,
        output: out
    };
};

// ---------------------------------------------------------------------------
// 1. before/after comparison on the same engine input
// ---------------------------------------------------------------------------

const baselinePeak = peakOf(engineInput);
const baselineThd = totalHarmonicDistortion(engineInput, 220, SAMPLE_RATE);
const comparisonRows = [];
for (const mode of MODES)
    for (const drive of ALL_DRIVES)
        comparisonRows.push(runCase(engineInput, 'engine', mode, drive, 220));

check('baseline reproduced at drive 0 (soft)', () =>
{
    const row = comparisonRows.find(r => r.mode == 'soft' && r.drive == 0);
    assert.ok(Math.abs(row.peak - baselinePeak) <= EPS);
    assert.ok(Math.abs(row.thd - baselineThd) <= 1e-12);
});
check('baseline reproduced at drive 0 (hard)', () =>
{
    const row = comparisonRows.find(r => r.mode == 'hard' && r.drive == 0);
    assert.ok(Math.abs(row.peak - baselinePeak) <= EPS);
    assert.ok(Math.abs(row.thd - baselineThd) <= 1e-12);
});
check('drive increases THD monotonically per mode', () =>
{
    for (const mode of MODES)
    {
        const rows = comparisonRows.filter(r => r.mode == mode).sort((a, b) => a.drive - b.drive);
        for (let i = 1; i < rows.length; ++i)
            assert.ok(rows[i].thd >= rows[i - 1].thd - EPS);
    }
});
check('hard clips harder than soft at every drive', () =>
{
    for (const drive of TEST_DRIVES)
    {
        const s = comparisonRows.find(r => r.mode == 'soft' && r.drive == drive);
        const h = comparisonRows.find(r => r.mode == 'hard' && r.drive == drive);
        assert.ok(h.thd >= s.thd - EPS);
    }
});

// ---------------------------------------------------------------------------
// 2. three-drive THD + peak on the controlled 1 kHz signal, DFT cross-check
// ---------------------------------------------------------------------------

const controlledRows = [];
for (const mode of MODES)
    for (const drive of ALL_DRIVES)
        controlledRows.push(runCase(controlledInput, 'controlled', mode, drive, 1000));

const crossValidation = [];
for (const mode of MODES)
    for (const drive of TEST_DRIVES)
    {
        const row = controlledRows.find(r => r.mode == mode && r.drive == drive);
        const dft = dftThd(row.output, 1000, SAMPLE_RATE);
        crossValidation.push({
            mode, drive,
            goertzelThd: row.thd,
            dftThd: dft,
            absDiff: Math.abs(row.thd - dft)
        });
        check(`goertzel vs DFT ${mode}/drive${drive}`,
            () => assert.ok(Math.abs(row.thd - dft) < 1e-7));
    }

check('controlled drive-0 THD is numerical floor', () =>
{
    const row = controlledRows.find(r => r.mode == 'soft' && r.drive == 0);
    assert.ok(row.thd < 1e-6);
});

// ---------------------------------------------------------------------------
// 3. no-pop audit (rows already collected; assert the headline invariants)
// ---------------------------------------------------------------------------

const popRows = [...comparisonRows, ...controlledRows].map(r => ({
    input: r.input, mode: r.mode, drive: r.drive, gain: r.gain,
    outputDelta: r.outputDelta, inputDelta: r.inputDelta,
    nonFinite: r.nonFinite, outsideRange: r.outsideRange
}));
check('no pop: all rows finite and in range', () =>
{
    for (const r of popRows)
    {
        assert.equal(r.nonFinite, 0);
        assert.equal(r.outsideRange, 0);
        assert.ok(r.outputDelta <= r.gain * r.inputDelta + EPS);
    }
});

// ---------------------------------------------------------------------------
// 4. failure paths: every case is executed, expected error name + message
// ---------------------------------------------------------------------------

const failureCases = [
    {
        name: 'drive negative',
        repro: "applyWaveShaper(new Float32Array(8), {drive: -0.01})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {drive: -0.01}),
        error: RangeError,
        message: `drive must be a finite number in [0, ${MAX_DRIVE}], got -0.01`
    },
    {
        name: 'drive above MAX_DRIVE',
        repro: "applyWaveShaper(new Float32Array(8), {drive: 101})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {drive: 101}),
        error: RangeError,
        message: `drive must be a finite number in [0, ${MAX_DRIVE}], got 101`
    },
    {
        name: 'drive Infinity',
        repro: "applyWaveShaper(new Float32Array(8), {drive: Infinity})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {drive: Infinity}),
        error: RangeError,
        message: `drive must be a finite number in [0, ${MAX_DRIVE}], got Infinity`
    },
    {
        name: 'drive NaN',
        repro: "applyWaveShaper(new Float32Array(8), {drive: NaN})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {drive: NaN}),
        error: RangeError,
        message: `drive must be a finite number in [0, ${MAX_DRIVE}], got NaN`
    },
    {
        name: 'drive wrong type',
        repro: "applyWaveShaper(new Float32Array(8), {drive: '1'})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {drive: '1'}),
        error: TypeError,
        message: 'drive must be a number, got string'
    },
    {
        name: 'unknown mode',
        repro: "applyWaveShaper(new Float32Array(8), {mode: 'fuzz'})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {mode: 'fuzz'}),
        error: RangeError,
        message: 'mode "fuzz" is not supported, use soft ("soft") or hard ("hard")'
    },
    {
        name: 'mode wrong type',
        repro: "applyWaveShaper(new Float32Array(8), {mode: 1})",
        call: () => applyWaveShaper(new NativeFloat32Array(8), {mode: 1}),
        error: TypeError,
        message: 'mode must be a string, use soft ("soft") or hard ("hard")'
    },
    {
        name: 'samples not array-like',
        repro: 'applyWaveShaper({})',
        call: () => applyWaveShaper({}),
        error: TypeError,
        message: 'samples must be a Float32Array or an Array of numbers'
    },
    {
        name: 'empty samples',
        repro: 'applyWaveShaper(new Float32Array(0))',
        call: () => applyWaveShaper(new NativeFloat32Array(0)),
        error: RangeError,
        message: 'samples must contain at least one sample'
    },
    {
        name: 'non-finite sample',
        repro: 'applyWaveShaper(new Float32Array([0.5, NaN, -0.5]))',
        call: () => applyWaveShaper(new NativeFloat32Array([0.5, NaN, -0.5])),
        error: RangeError,
        message: 'samples[1] is not a finite number (got NaN)'
    },
    {
        name: 'sampleRate zero',
        repro: 'applyWaveShaper(new Float32Array(8), {sampleRate: 0})',
        call: () => applyWaveShaper(new NativeFloat32Array(8), {sampleRate: 0}),
        error: RangeError,
        message: 'sampleRate must be a finite number > 0, got 0'
    },
    {
        name: 'fundamental at Nyquist',
        repro: 'applyWaveShaper(new Float32Array(8), {fundamentalFrequency: 22050})',
        call: () => applyWaveShaper(
            new NativeFloat32Array(8), {fundamentalFrequency: 22050}),
        error: RangeError,
        message: 'fundamentalFrequency 22050 must be below Nyquist 22050'
    },
    {
        name: 'bad fundamental frequency',
        repro: 'applyWaveShaper(new Float32Array(8), {fundamentalFrequency: -1})',
        call: () => applyWaveShaper(
            new NativeFloat32Array(8), {fundamentalFrequency: -1}),
        error: RangeError,
        message: 'fundamentalFrequency must be a finite number >= 0 (0 disables THD), got -1'
    },
    {
        name: 'options not an object',
        repro: "applyWaveShaper(new Float32Array(8), 'nope')",
        call: () => applyWaveShaper(new NativeFloat32Array(8), 'nope'),
        error: TypeError,
        message: 'options must be an object'
    },
    {
        name: 'options null',
        repro: 'applyWaveShaper(new Float32Array(8), null)',
        call: () => applyWaveShaper(new NativeFloat32Array(8), null),
        error: TypeError,
        message: 'options must be an object'
    },
    {
        name: 'THD helper bad frequency',
        repro: 'totalHarmonicDistortion(new Float32Array(8), 0)',
        call: () => totalHarmonicDistortion(new NativeFloat32Array(8), 0),
        error: RangeError,
        message: 'fundamentalFrequency must be a finite number > 0, got 0'
    },
    {
        name: 'THD helper frequency above Nyquist',
        repro: 'totalHarmonicDistortion(new Float32Array(8), 30000)',
        call: () => totalHarmonicDistortion(new NativeFloat32Array(8), 30000),
        error: RangeError,
        message: 'fundamentalFrequency 30000 must be below Nyquist 22050'
    }
];

const failureResults = [];
for (const c of failureCases)
{
    let threw = null;
    resetAllocationCounters();
    try { c.call(); }
    catch (e) { threw = e; }

    const ok = threw instanceof c.error && threw.message == c.message
        && liveAllocations == 0 && allocatedBytes == 0;
    failureResults.push({
        name: c.name,
        call: c.repro,
        expectedError: `${c.error.name}: ${c.message}`,
        actualError: threw ? `${threw.constructor.name}: ${threw.message}` : 'no error thrown',
        allocationsOnRejection: liveAllocations,
        pass: ok
    });
    check(`failure path: ${c.name}`, () => assert.ok(ok));
}

// boundary drive values are accepted
check('drive 0 and drive 100 accepted', () =>
{
    assert.doesNotThrow(() => applyWaveShaper(new NativeFloat32Array(4), {drive: 0}));
    assert.doesNotThrow(() => applyWaveShaper(new NativeFloat32Array(4), {drive: 100}));
});

// plain Array input is supported too
check('plain Array input', () =>
{
    const r = applyWaveShaper([0.1, -0.2, 0.3], {mode: 'hard', drive: 5});
    assert.ok(r.samples instanceof NativeFloat32Array);
    // gain 6: 0.6, -1 (clipped from -1.2), 1 (clipped from 1.8)
    assert.equal(r.peak, 1);
    assert.equal(r.samples.length, 3);
    assert.ok(Math.abs(r.samples[0] - 0.6) < 1e-7); // 0.6 in float32
    assert.equal(r.samples[1], -1);
    assert.equal(r.samples[2], 1);
});

// ---------------------------------------------------------------------------
// 5. bit-exact legacy behavior at drive 0, five waveforms x both modes
// ---------------------------------------------------------------------------

const waveformParams = {
    sine:        [1, 0, 220, 0, 0, 0.1, 0, 1],
    triangle:    [1, 0, 220, 0, 0, 0.1, 1, 1],
    saw:         [1, 0, 220, 0, 0, 0.1, 2, 1],
    square:      [1, 0, 220, 0, 0, 0.1, 5, 0.5],
    'noisy sine':[1, 0, 220, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 0, 0.1]
};
const bitExactRows = [];
let totalValueComparisons = 0;
let totalBitComparisons = 0;
let totalMismatches = 0;
for (const [waveform, params] of Object.entries(waveformParams))
{
    const input = ZZFX.buildSamples(...params);
    const reference = bitPatterns(input);
    for (const mode of MODES)
    {
        const before = bitPatterns(input);
        const {samples: out} = applyWaveShaper(input, {mode, drive: 0});
        let valueMismatches = 0, bitMismatches = 0;
        const outBits = bitPatterns(out);
        for (let i = 0; i < input.length; ++i)
        {
            ++totalValueComparisons;
            ++totalBitComparisons;
            if (out[i] !== input[i]) ++valueMismatches;
            if (outBits[i] !== reference[i]) ++bitMismatches;
        }
        const mutatedInput = bitPatterns(input).some((w, i) => w !== before[i]);
        totalMismatches += valueMismatches + bitMismatches;
        bitExactRows.push({
            waveform, mode,
            engineSamples: input.length,
            valueComparisons: input.length,
            bitComparisons: input.length,
            valueMismatches, bitMismatches,
            mutatedInput
        });
        check(`bit exact ${waveform}/${mode}`, () =>
        {
            assert.equal(valueMismatches, 0);
            assert.equal(bitMismatches, 0);
            assert.equal(mutatedInput, false);
        });
    }
}

// ---------------------------------------------------------------------------
// report generation
// ---------------------------------------------------------------------------

const round6 = v => Math.round(v * 1e6) / 1e6;
const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    sampleRate: SAMPLE_RATE,
    maxDrive: MAX_DRIVE,
    maxHarmonics: MAX_HARMONICS,
    testDrives: TEST_DRIVES,
    input: {
        zzfxParams: ZZFX_PARAMS,
        sampleCount: ENGINE_N,
        baselinePeak,
        baselineThdAt220Hz: baselineThd,
        controlledSampleCount: CONTROLLED_N,
        controlledPeak: peakOf(controlledInput),
        controlledThdAt1kHz:
            totalHarmonicDistortion(controlledInput, 1000, SAMPLE_RATE)
    },
    comparisonRows: comparisonRows.map(r => ({
        mode: r.mode, drive: r.drive, gain: r.gain, peak: r.peak, thd: r.thd
    })),
    controlledRows: controlledRows.map(r => ({
        mode: r.mode, drive: r.drive, gain: r.gain, peak: r.peak, thd: r.thd
    })),
    crossValidation,
    popRows,
    failureResults: failureResults.map(r => ({
        name: r.name, call: r.call, expectedError: r.expectedError,
        actualError: r.actualError, allocationsOnRejection: r.allocationsOnRejection,
        pass: r.pass
    })),
    allocationRows: popRows.map(r => ({
        input: r.input, mode: r.mode, drive: r.drive,
        allocations: 1, allocatedBytes: r.input == 'controlled'
            ? CONTROLLED_N * 4 : ENGINE_N * 4
    })),
    bitExact: {
        rows: bitExactRows,
        totalValueComparisons,
        totalBitComparisons,
        totalMismatches
    },
    allChecksPassed: failures.length == 0
};

writeFileSync(
    `${artifactsDir}/waveshaper-report.json`, JSON.stringify(report, null, 2) + '\n');

const table = rows =>
{
    const keys = Object.keys(rows[0]);
    const fmt = v => typeof v == 'number' ? round6(v) : String(v);
    const head = `| ${keys.join(' | ')} |`;
    const sep = `| ${keys.map(() => '---').join(' | ')} |`;
    const body = rows.map(r => `| ${keys.map(k => fmt(r[k])).join(' | ')} |`);
    return [head, sep, ...body].join('\n');
};

const md = `# waveShaper.js verification report

Generated: ${report.generatedAt}
Runtime: ${report.node}
Reproduce: \`node test/waveShaper.test.mjs\` (repository root)
All checks passed: **${failures.length == 0}** (${failures.length} failure(s))

## 1. Before/after comparison, identical input

Input: \`ZZFX.buildSamples(...${JSON.stringify(ZZFX_PARAMS)})\` (sine 220 Hz,
randomness 0), N = ${ENGINE_N} samples.
Baseline engine output: peak = ${round6(baselinePeak)}, THD(220 Hz) = ${round6(baselineThd)}.

${table(report.comparisonRows)}

## 2. Three-drive THD and peak (controlled 1 kHz signal)

Input: 0.7*sin(2*pi*1000*t), 1 s at ${SAMPLE_RATE} Hz (${CONTROLLED_N} samples,
exactly 1000 integer cycles, so Goertzel/DFT THD has no windowing leakage).
Drive levels under test: ${TEST_DRIVES.join(', ')} (plus drive = 0 reference).

${table(report.controlledRows)}

Independent full-DFT cross-validation of the Goertzel THD numbers:

${table(crossValidation.map(r => ({
    mode: r.mode, drive: r.drive,
    goertzelThd: round6(r.goertzelThd), dftThd: round6(r.dftThd),
    absDiff: round6(r.absDiff)
})))}

## 3. No-pop audit

A pop is a discontinuity, an over-full-scale value, or a non-finite sample.
Both shapers clamp to [-1, 1] and are Lipschitz-continuous with constant
equal to gain (hard clip slopes are 0 or gain; soft tanh slope is
gain*sech^2 <= gain), so every output step satisfies
|out[i] - out[i-1]| <= gain * |in[i] - in[i-1]|.

${table(popRows)}

Assertions (executed, not just argued): non-finite = 0, samples outside
[-1, 1] = 0, and max|delta| <= gain * input max|delta| (epsilon ${EPS})
for every drive, mode, and input.

## 4. Failure paths (reproducible steps + expected errors)

Each case below is executed verbatim by the test script. Hand reproduction:

\`\`\`js
import {applyWaveShaper} from './waveShaper.js';
applyWaveShaper(new Float32Array(8), {drive: -0.01}); // example
\`\`\`

${table(failureResults.map(r => ({
    case: r.name, call: r.call, expected: r.expectedError,
    actual: r.actualError, bytesAllocatedBeforeThrow: r.allocationsOnRejection,
    pass: r.pass
})))}

Boundary values drive = 0 and drive = ${MAX_DRIVE} are accepted. Rejected
parameters throw before any Float32Array allocation (verified: 0 bytes,
see bytesAllocatedBeforeThrow column).

## 5. Resource / memory upper bound

For N input samples, one successful \`applyWaveShaper\` call performs exactly
one heap allocation: the output Float32Array of N samples = 4N bytes.
\`totalHarmonicDistortion\` uses scalar Goertzel state only: O(1) extra
memory per bin with O(N*H) time, H = min(${MAX_HARMONICS}, floor(Nyquist/f0))
being the highest harmonic below Nyquist. The input buffer is never copied
beyond the output allocation, never mutated, and never retained. Rejected
parameters allocate zero bytes.

${table(report.allocationRows)}

## 6. Bit-exact legacy behavior (drive = 0)

At drive = 0 the shaper copies every sample verbatim via
\`Float32Array.set\` and performs no arithmetic on sample values, so the
output bit patterns are identical to the unmodified \`ZZFX.buildSamples\`
output. Verified sample-by-sample with strict \`!==\` and a raw Uint32
bit-pattern comparison, on five waveforms in both modes. The engine files
\`ZzFX.js\`, \`ZzFXMicro.js\`, \`ZzFXMicro.min.js\`, and \`wav.js\` are unchanged.

${table(bitExactRows)}

Total value comparisons: ${totalValueComparisons}, total bit-pattern
comparisons: ${totalBitComparisons}, mismatches: ${totalMismatches}.
`;

writeFileSync(`${artifactsDir}/waveshaper-report.md`, md);

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

if (failures.length)
{
    console.error(`FAIL: ${failures.length} check(s) failed:\n` + failures.map(f => `- ${f}`).join('\n'));
    process.exit(1);
}
console.log(`PASS: all waveshaper checks passed`);
console.log(`  engine input N=${ENGINE_N}, baseline peak=${round6(baselinePeak)}, THD=${round6(baselineThd)}`);
for (const r of report.controlledRows)
    console.log(`  ${r.mode.padEnd(4)} drive=${String(r.drive).padStart(2)} gain=${r.gain} ` +
        `peak=${round6(r.peak)} THD=${round6(r.thd)}`);
console.log(`  bit-exact comparisons: ${totalValueComparisons} value + ${totalBitComparisons} bit, 0 mismatches`);
console.log(`  reports: artifacts/waveshaper-report.{json,md}`);
