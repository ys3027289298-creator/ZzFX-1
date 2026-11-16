/*

ZzFXEffects - spatial effects (feedback delay + Schroeder reverb) for ZzFX

- applyEffects() takes a Float32Array of dry samples and returns a new
  Float32Array with the requested effects. When no effect is active the exact
  same buffer reference is returned, so the old behavior stays bit identical.
- Every storage buffer is a preallocated Float32Array; nothing grows per
  sample and all tail lengths are hard capped, so tails can never run on
  indefinitely.
- Invalid parameters throw ZzFXEffectsError with stable codes ZZFX_E1..E10.

MIT License, same as ZzFX.

*/

'use strict';

export const ZZFX_EFFECT_LIMITS =
{
    sampleRate: 44100,
    maxDelayTimeSeconds: 1,        // delayTime range [0, 1]
    maxDelayFeedback: .95,         // feedback range [0, 0.95), 0.95 rejected
    maxMix: 1,                     // mix ranges [0, 1]
    maxReverbTailSeconds: 2,       // reverbTail range [0, 2]
    maxDelayTailSeconds: 3,        // hard cap on rendered delay tail
    tailThreshold: 1e-4,           // -80 dB, taps below this are inaudible
    combSizes: [1116, 1188, 1277, 1356], // Freeverb comb line lengths
    allpassSize: 556,              // Freeverb allpass line length
    allpassGain: .5
};

const R = ZZFX_EFFECT_LIMITS.sampleRate;
const MAX_DELAY_TAIL_SAMPLES = ZZFX_EFFECT_LIMITS.maxDelayTailSeconds * R;
const MAX_REVERB_TAIL_SAMPLES = ZZFX_EFFECT_LIMITS.maxReverbTailSeconds * R;
const THRESHOLD = ZZFX_EFFECT_LIMITS.tailThreshold;

const OPTION_KEYS =
[
    'delayTime', 'delayFeedback', 'delayMix',
    'reverbTail', 'reverbMix'
];

const DEFAULTS =
{
    delayTime: 0,
    delayFeedback: 0,
    delayMix: 0,
    reverbTail: 0,
    reverbMix: 0
};

export class ZzFXEffectsError extends Error
{
    constructor(code, codeNumber, message)
    {
        super(message);
        this.name = 'ZzFXEffectsError';
        this.code = code;
        this.codeNumber = codeNumber;
    }
}

function fail(codeNumber, message)
{
    throw new ZzFXEffectsError(`ZZFX_E${codeNumber}`, codeNumber, message);
}

function checkFiniteRange(value, codeNumber, name, min, max, exclusiveMax=false)
{
    if (!Number.isFinite(value))
        fail(codeNumber, `${name} must be a finite number`);
    if (value < min || value > max || (exclusiveMax && value >= max))
        fail(codeNumber, `${name} out of range`);
}

function validateOptions(options)
{
    if (options === null || options === undefined)
        return null;

    const proto = Object.getPrototypeOf(options);
    if (proto !== Object.prototype && proto !== null)
        fail(1, 'effects options must be a plain object');

    for (const key of Object.keys(options))
        if (!OPTION_KEYS.includes(key))
            fail(7, `unknown effects option "${key}"`);

    const hasDelayTime = Object.prototype.hasOwnProperty.call(options, 'delayTime');
    const hasFeedback = Object.prototype.hasOwnProperty.call(options, 'delayFeedback');
    const hasDelayMix = Object.prototype.hasOwnProperty.call(options, 'delayMix');
    if ((hasFeedback || hasDelayMix) && !hasDelayTime)
        fail(9, 'delayFeedback/delayMix require an explicit delayTime (use delayTime: 0 to disable the delay)');

    const o = {...DEFAULTS, ...options};

    checkFiniteRange(o.delayTime, 2, 'delayTime', 0, ZZFX_EFFECT_LIMITS.maxDelayTimeSeconds);
    checkFiniteRange(o.delayFeedback, 3, 'delayFeedback', 0,
        ZZFX_EFFECT_LIMITS.maxDelayFeedback, true);
    checkFiniteRange(o.delayMix, 4, 'delayMix', 0, ZZFX_EFFECT_LIMITS.maxMix);
    checkFiniteRange(o.reverbTail, 5, 'reverbTail', 0, ZZFX_EFFECT_LIMITS.maxReverbTailSeconds);
    checkFiniteRange(o.reverbMix, 6, 'reverbMix', 0, ZZFX_EFFECT_LIMITS.maxMix);

    if (o.reverbMix > 0 && !(o.reverbTail > 0))
        fail(5, 'reverbTail must be greater than 0 when reverbMix is greater than 0');

    return o;
}

function validateBuffer(buffer)
{
    if (!(buffer instanceof Float32Array) || buffer.length === 0)
        fail(8, 'input must be a non-empty Float32Array');
    for (let i = buffer.length; i--;)
        if (!Number.isFinite(buffer[i]))
            fail(10, `input sample ${i} is not finite`);
}

// number of feedback taps louder than the -80 dB threshold:
// tap k (k = 0,1,...) has amplitude mix * feedback^k
function countAudibleTaps(mix, feedback)
{
    let count = 0;
    for (let amplitude = mix; amplitude > THRESHOLD; amplitude *= feedback)
        ++count;
    return count;
}

// comb feedback derived from the allocated tail: g^(tail/lineLength) = threshold,
// so the impulse response is at/below threshold when the buffer ends and |g| < 1
// always holds because lineLength, tail > 0 and threshold is in (0,1).
function combGain(lineLength, tailSamples)
{
    return THRESHOLD ** (lineLength / tailSamples);
}

// Exact buffer plan for an effects call, used by applyEffects and by the
// verification harness to prove memory accounting.
export function getBufferPlan(dryLength, rawOptions)
{
    const o = validateOptions(rawOptions);
    const allocations = [];
    if (!o)
        return {active:false, delayOn:false, reverbOn:false,
            outputSamples:dryLength, delayTailSamples:0, reverbTailSamples:0,
            allocations};

    const delayOn = o.delayTime > 0 && o.delayMix > 0;
    const reverbOn = o.reverbMix > 0;
    if (!delayOn && !reverbOn)
        return {active:false, delayOn:false, reverbOn:false,
            outputSamples:dryLength, delayTailSamples:0, reverbTailSamples:0,
            allocations};

    let delaySamples = 0;
    let delayTailSamples = 0;
    if (delayOn)
    {
        delaySamples = Math.max(1, Math.round(o.delayTime * R));
        const audibleTaps = countAudibleTaps(o.delayMix, o.delayFeedback);
        delayTailSamples = Math.min(MAX_DELAY_TAIL_SAMPLES, audibleTaps * delaySamples);
        allocations.push({name:'delay ring buffer', samples:delaySamples});
    }

    let reverbTailSamples = 0;
    if (reverbOn)
    {
        reverbTailSamples = Math.min(MAX_REVERB_TAIL_SAMPLES, Math.round(o.reverbTail * R));
        for (const size of ZZFX_EFFECT_LIMITS.combSizes)
            allocations.push({name:`comb ${size}`, samples:size});
        allocations.push({name:'allpass', samples:ZZFX_EFFECT_LIMITS.allpassSize});
    }

    const outputSamples = dryLength + delayTailSamples + reverbTailSamples;
    allocations.unshift({name:'output', samples:outputSamples});

    return {active:true, delayOn, reverbOn, options:o, delaySamples,
        audibleTaps: delayOn ? countAudibleTaps(o.delayMix, o.delayFeedback) : 0,
        delayTailSamples, reverbTailSamples, outputSamples, allocations};
}

// Analytic per-sample amplitude bound for the configured chain.
//
// Delay stage: at most one echo tap contributes at each sample, so
//   |delay(x)| <= (1 + delayMix) * |x|  (wet taps are the geometric sequence
//   mix*feedback^k, which is bounded by mix because 0 <= feedback < 1).
//
// Reverb stage: 4 parallel combs each have gain g < 1, giving an IIR gain of
//   1/(1-g); the allpass is unit gain. Hence
//   |reverb(x)| <= (1 + reverbMix * maxComb 1/(1-g)) * |x|.
//
// The product of the two stage bounds is a hard per-sample peak bound for any
// input, which proves the chain can never diverge for validated parameters.
export function getPeakBound(rawOptions)
{
    const o = validateOptions(rawOptions);
    if (!o)
        return {active:false, bound:1};

    const delayOn = o.delayTime > 0 && o.delayMix > 0;
    const reverbOn = o.reverbMix > 0;
    let delayGain = 1;
    let reverbGain = 1;

    if (delayOn)
        delayGain = 1 + o.delayMix;

    if (reverbOn)
    {
        const tailSamples = Math.min(MAX_REVERB_TAIL_SAMPLES,
            Math.max(1, Math.round(o.reverbTail * R)));
        let maxIirGain = 0;
        for (const size of ZZFX_EFFECT_LIMITS.combSizes)
        {
            const g = combGain(size, tailSamples);
            maxIirGain = Math.max(maxIirGain, 1 / (1 - g));
        }
        reverbGain = 1 + o.reverbMix * maxIirGain;
    }

    return {
        active: delayOn || reverbOn,
        delayOn, reverbOn,
        maxCombGain: reverbOn ? combGain(
            Math.min(...ZZFX_EFFECT_LIMITS.combSizes),
            Math.min(MAX_REVERB_TAIL_SAMPLES, Math.max(1, Math.round(o.reverbTail * R)))) : 0,
        bound: delayGain * reverbGain
    };
}

export function applyEffects(buffer, rawOptions)
{
    const o = validateOptions(rawOptions);
    validateBuffer(buffer);
    if (!o)
        return buffer;

    const delayOn = o.delayTime > 0 && o.delayMix > 0;
    const reverbOn = o.reverbMix > 0;
    if (!delayOn && !reverbOn)
        return buffer; // inactive options: identical reference, bit for bit

    const dryLength = buffer.length;
    const plan = getBufferPlan(dryLength, o);
    const out = new Float32Array(plan.outputSamples);
    const delayOutLength = dryLength + plan.delayTailSamples;

    // stage 1: feedback delay written straight into the output buffer
    if (delayOn)
    {
        const ring = new Float32Array(plan.delaySamples);
        const feedback = o.delayFeedback;
        const mix = o.delayMix;
        let pos = 0;

        for (let i = 0; i < dryLength; ++i)
        {
            const x = buffer[i];
            const wet = ring[pos];
            ring[pos] = x + feedback * wet;
            out[i] = x + mix * wet;
            pos = (pos + 1) % plan.delaySamples;
        }
        for (let k = 0; k < plan.delayTailSamples; ++k)
        {
            const wet = ring[pos];
            ring[pos] = feedback * wet;
            out[dryLength + k] = mix * wet;
            pos = (pos + 1) % plan.delaySamples;
        }
    }
    else
    {
        out.set(buffer);
    }

    // stage 2: 4 parallel Schroeder combs + 1 allpass, mixed in place
    if (reverbOn)
    {
        const tail = plan.reverbTailSamples;
        const combs = ZZFX_EFFECT_LIMITS.combSizes.map(size =>
        ({
            buf:new Float32Array(size),
            gain:combGain(size, tail),
            index:0
        }));
        const apBuf = new Float32Array(ZZFX_EFFECT_LIMITS.allpassSize);
        let apIndex = 0;
        const apGain = ZZFX_EFFECT_LIMITS.allpassGain;
        const wetMix = o.reverbMix;

        for (let i = 0; i < out.length; ++i)
        {
            const x = i < delayOutLength ? out[i] : 0;
            let combSum = 0;
            for (const comb of combs)
            {
                const y = x + comb.gain * comb.buf[comb.index];
                comb.buf[comb.index] = y;
                comb.index = (comb.index + 1) % comb.buf.length;
                combSum += y;
            }
            const combOut = combSum / combs.length;

            const allpassInput = combOut - apGain * apBuf[apIndex];
            const allpassOut = apGain * allpassInput + apBuf[apIndex];
            apBuf[apIndex] = allpassInput;
            apIndex = (apIndex + 1) % apBuf.length;

            out[i] = (1 - wetMix) * x + wetMix * allpassOut;
        }
    }

    return out;
}
