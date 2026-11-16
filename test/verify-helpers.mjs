import {createHash} from 'node:crypto';

export const sha256 = floatArray =>
    createHash('sha256')
        .update(Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength))
        .digest('hex');

export const peakOf = floatArray =>
{
    let peak = 0;
    for (const v of floatArray)
    {
        const a = Math.abs(v);
        if (a > peak) peak = a;
    }
    return peak;
};

export const allFinite = floatArray =>
{
    for (const v of floatArray)
        if (!Number.isFinite(v)) return false;
    return true;
};

// measured tail: samples after the dry span whose magnitude exceeds the
// -80 dB threshold, reported in milliseconds
export const measuredTailMs = (floatArray, dryLength, sampleRate, threshold=1e-4) =>
{
    let last = -1;
    for (let i = floatArray.length - 1; i >= dryLength; --i)
    {
        if (Math.abs(floatArray[i]) > threshold)
        {
            last = i;
            break;
        }
    }
    return last < 0 ? 0 : (last - dryLength + 1) * 1000 / sampleRate;
};

// impulse response of the delay alone: peaks sampled exactly at tap positions
export const impulseTapPeaks = (applyEffects, options, dryLength, sampleRate) =>
{
    const impulse = new Float32Array(dryLength);
    impulse[0] = 1;
    const rendered = applyEffects(impulse,
        {delayTime:options.delayTime, delayFeedback:options.delayFeedback, delayMix:options.delayMix});
    const delaySamples = Math.max(1, Math.round(options.delayTime * sampleRate));
    const taps = [1];
    for (let i = delaySamples; i < rendered.length; i += delaySamples)
        taps.push(rendered[i]);
    return {taps, rendered};
};
