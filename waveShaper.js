// waveShaper.js - waveshaping distortion for ZzFX sample buffers
// MIT License
//
// Two clipping modes:
//   soft: tanh-based soft clipping, out = tanh(gain * in)
//   hard: hard clipping,         out = clamp(gain * in, -1, 1)
// where gain = drive + 1, so drive = 0 means gain = 1 and the output is
// a bit-exact copy of the input (Float32Array.set, no arithmetic).
//
// Both shapers clamp their output to [-1, 1] and are Lipschitz continuous
// with constant gain, so no sample can exceed full scale and no
// discontinuity larger than gain * the input's largest step is introduced.

'use strict';

// largest accepted drive value
export const MAX_DRIVE = 100;

// highest harmonic bin considered by totalHarmonicDistortion
export const MAX_HARMONICS = 21;

const isFiniteNumber = v => typeof v == 'number' && Number.isFinite(v);

// validate an array-like of finite numeric samples and return its length
function validateSamples(samples)
{
    if (!(samples instanceof Float32Array) && !Array.isArray(samples))
        throw TypeError('samples must be a Float32Array or an Array of numbers');

    if (!samples.length)
        throw RangeError('samples must contain at least one sample');

    for (let i = samples.length; i--;)
        if (!isFiniteNumber(samples[i]))
            throw RangeError(`samples[${i}] is not a finite number (got ${samples[i]})`);

    return samples.length;
}

function validateOptions(options)
{
    if (options === null || typeof options != 'object')
        throw TypeError('options must be an object');
}

function validateDrive(drive)
{
    if (typeof drive != 'number')
        throw TypeError(`drive must be a number, got ${typeof drive}`);

    if (!Number.isFinite(drive) || drive < 0 || drive > MAX_DRIVE)
        throw RangeError(`drive must be a finite number in [0, ${MAX_DRIVE}], got ${drive}`);
}

function validateMode(mode)
{
    if (typeof mode != 'string')
        throw TypeError('mode must be a string, use soft ("soft") or hard ("hard")');

    if (mode != 'soft' && mode != 'hard')
        throw RangeError(`mode "${mode}" is not supported, use soft ("soft") or hard ("hard")`);
}

// total harmonic distortion of samples at fundamentalFrequency
//
// THD = sqrt(sum of harmonic powers 2..H) / fundamental power, measured with
// one scalar Goertzel filter per bin (O(1) extra memory per bin, O(N*H) time).
// H is the lowest of MAX_HARMONICS and the highest harmonic below Nyquist.
export function totalHarmonicDistortion(samples, fundamentalFrequency, sampleRate = 44100)
{
    validateSamples(samples);

    if (!isFiniteNumber(fundamentalFrequency) || fundamentalFrequency <= 0)
        throw RangeError(
            `fundamentalFrequency must be a finite number > 0, got ${fundamentalFrequency}`);

    if (!isFiniteNumber(sampleRate) || sampleRate <= 0)
        throw RangeError(`sampleRate must be a finite number > 0, got ${sampleRate}`);

    const nyquist = sampleRate / 2;
    if (fundamentalFrequency >= nyquist)
        throw RangeError(
            `fundamentalFrequency ${fundamentalFrequency} must be below Nyquist ${nyquist}`);

    // at least the 2nd harmonic must fit below Nyquist
    if (2 * fundamentalFrequency >= nyquist)
        throw RangeError(
            `fundamentalFrequency ${fundamentalFrequency} is too close to Nyquist ${nyquist} ` +
            'for a 2nd harmonic measurement');

    const n = samples.length;
    const harmonicCount = Math.min(
        MAX_HARMONICS, Math.floor((nyquist - 1e-9) / fundamentalFrequency));

    // Goertzel power of a single DFT bin
    const binPower = frequency =>
    {
        const k = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
        let sPrev = 0, sPrev2 = 0;
        for (let i = 0; i < n; ++i)
        {
            const s = samples[i] + k * sPrev - sPrev2;
            sPrev2 = sPrev;
            sPrev = s;
        }
        // normalized so a pure sinusoid of amplitude A yields A^2 / 2
        return (sPrev2 * sPrev2 + sPrev * sPrev - k * sPrev * sPrev2) / (n * n / 2);
    };

    const fundamentalPower = binPower(fundamentalFrequency);
    let harmonicPower = 0;
    for (let h = 2; h <= harmonicCount; ++h)
        harmonicPower += binPower(h * fundamentalFrequency);

    return Math.sqrt(harmonicPower / fundamentalPower);
}

// apply waveshaping distortion to a copy of the samples
//
// returns { samples, peak, gain, thd } where:
//   samples: new Float32Array, the input is never mutated
//   peak:    maximum absolute output sample
//   gain:    drive + 1, the pre-clip gain that was applied
//   thd:     measured THD at options.fundamentalFrequency, or null when omitted
export function applyWaveShaper(samples, options = {})
{
    validateOptions(options);
    const n = validateSamples(samples);
    const {drive = 0, mode = 'soft', sampleRate = 44100, fundamentalFrequency = 0} = options;

    validateDrive(drive);
    validateMode(mode);

    if (!isFiniteNumber(sampleRate) || sampleRate <= 0)
        throw RangeError(`sampleRate must be a finite number > 0, got ${sampleRate}`);

    if (!isFiniteNumber(fundamentalFrequency) || fundamentalFrequency < 0)
        throw RangeError(
            `fundamentalFrequency must be a finite number >= 0 (0 disables THD), got ${fundamentalFrequency}`);

    if (fundamentalFrequency)
    {
        const nyquist = sampleRate / 2;
        if (fundamentalFrequency >= nyquist)
            throw RangeError(
                `fundamentalFrequency ${fundamentalFrequency} must be below Nyquist ${nyquist}`);
    }

    // the single heap allocation of this function
    const output = new Float32Array(n);
    const gain = drive + 1;

    if (drive === 0)
    {
        // verbatim copy: no arithmetic on sample values, bit patterns identical
        output.set(samples);
    }
    else if (mode == 'soft')
    {
        for (let i = 0; i < n; ++i)
        {
            const x = gain * samples[i];
            // guard the exp against overflow on extreme (still finite) inputs
            const y = Math.abs(x) < 50 ? Math.tanh(x) : (x < 0 ? -1 : 1);
            output[i] = y;
        }
    }
    else // hard
    {
        for (let i = 0; i < n; ++i)
        {
            const x = gain * samples[i];
            output[i] = x < -1 ? -1 : x > 1 ? 1 : x;
        }
    }

    let peak = 0;
    for (let i = n; i--;)
    {
        const a = Math.abs(output[i]);
        if (a > peak) peak = a;
    }

    const thd = fundamentalFrequency
        ? totalHarmonicDistortion(output, fundamentalFrequency, sampleRate)
        : null;

    return {samples: output, peak, gain, thd};
}
