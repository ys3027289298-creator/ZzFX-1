// Shared DSP helpers for cross-rate validation. There is exactly ONE
// resampling implementation here; every rate pair and every sound goes
// through the same ratio-driven function (no per-sample-rate branches).
'use strict';

// Hann-windowed sinc (ideal low-pass) resampler with normalized gain.
export function resampleSinc(input, fromRate, toRate, halfWidth = 16)
{
    if (fromRate === toRate) return input.slice();
    const ratio = fromRate / toRate;
    const outLength = Math.round(input.length / ratio);
    const out = new Float32Array(outLength);
    const cutoff = Math.min(1, fromRate / toRate);

    for (let i = 0; i < outLength; i++)
    {
        const center = i * ratio;
        const first = Math.ceil(center - halfWidth);
        const last = Math.floor(center + halfWidth);
        let acc = 0;
        for (let j = first; j <= last; j++)
        {
            if (j < 0 || j >= input.length) continue;
            const x = center - j;
            const sincArg = Math.PI * cutoff * x;
            const sinc = x === 0 ? cutoff : Math.sin(sincArg) / (Math.PI * x);
            const windowArg = (x / halfWidth) * Math.PI;
            const hann = 0.5 * (1 + Math.cos(windowArg));
            acc += input[j] * sinc * hann;
        }
        out[i] = acc;
    }
    return out;
}

// Magnitude spectrum on a fixed bin grid (both signals are on the same sample
// grid when this is called, so bins map to identical frequencies).
function magnitudeSpectrum(samples, sampleRate, binCount = 1024)
{
    const n = samples.length;
    const mags = new Float64Array(binCount);
    const step = Math.max(1, Math.floor(n / 8192));
    for (let k = 1; k < binCount; k++)
    {
        let re = 0, im = 0;
        const angleBase = (2 * Math.PI * k) / (2 * binCount);
        for (let i = 0; i < n; i += step)
        {
            const angle = angleBase * i;
            re += samples[i] * Math.cos(angle);
            im -= samples[i] * Math.sin(angle);
        }
        mags[k] = Math.sqrt(re * re + im * im);
    }
    return {mags, binToHz: k => k * sampleRate / (2 * binCount)};
}

// Refined peak location (fractional bin) via parabolic interpolation.
function interpolatedPeak(mags, bin)
{
    const left = mags[bin - 1] || 0;
    const center = mags[bin];
    const right = mags[bin + 1] || 0;
    const denom = left - 2 * center + right;
    const shift = denom ? (0.5 * (left - right)) / denom : 0;
    return bin + shift;
}

// Pitch consistency between two signals already on the SAME sample grid.
// Returns the median relative frequency drift (0 = identical pitch) measured
// across all prominent spectral peaks, which is robust to a single peak
// jumping between harmonics.
export function pitchDrift(reference, candidate, sampleRate)
{
    const ref = magnitudeSpectrum(reference, sampleRate);
    const cand = magnitudeSpectrum(candidate, sampleRate);

    // find prominent peaks (local maxima above a relative threshold)
    const threshold = Math.max(...ref.mags) * 0.25;
    const drifts = [];
    for (let k = 2; k < ref.mags.length - 2; k++)
    {
        if (ref.mags[k] < threshold) continue;
        if (!(ref.mags[k] >= ref.mags[k - 1] && ref.mags[k] >= ref.mags[k + 1])) continue;

        // locate the strongest candidate peak within a wide window; bin
        // quantization (~21 Hz) is far coarser than the drift we are testing,
        // so matching on the local maximum avoids false quantized offsets
        let bestK = k, bestVal = -1;
        const window = 8;
        for (let j = k - window; j <= k + window; j++)
        {
            if (j > 0 && j < cand.mags.length && cand.mags[j] > bestVal)
            { bestVal = cand.mags[j]; bestK = j; }
        }
        const freqRef = ref.binToHz(interpolatedPeak(ref.mags, k));
        const freqCand = cand.binToHz(interpolatedPeak(cand.mags, bestK));
        if (freqRef > 0) drifts.push(Math.abs(freqCand - freqRef) / freqRef);
    }
    if (!drifts.length) return 0;
    drifts.sort((a, b) => a - b);
    return drifts[Math.floor(drifts.length / 2)];
}

// Absolute dominant pitch (Hz) via the strongest spectral peak, for reporting.
export function estimatePitch(samples, sampleRate)
{
    const {mags, binToHz} = magnitudeSpectrum(samples, sampleRate);
    let bestBin = 0, bestMag = 0;
    for (let k = 1; k < mags.length; k++)
        if (mags[k] > bestMag) { bestMag = mags[k]; bestBin = k; }
    return binToHz(bestBin);
}

export function rms(a)
{
    let sum = 0;
    for (const v of a) sum += v * v;
    return Math.sqrt(sum / a.length);
}

export function rmse(a, b)
{
    const n = Math.min(a.length, b.length);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum / n);
}

// Best RMSE over small integer-sample offsets, removing sub-sample grid
// alignment differences that resampling cannot eliminate exactly.
export function alignedRmse(referenceP, candidateP, maxShiftSamples = 4)
{
    let best = Infinity;
    for (let shift = -maxShiftSamples; shift <= maxShiftSamples; shift++)
    {
        let sum = 0, count = 0;
        const start = Math.max(0, shift);
        const end = Math.min(referenceP.length, candidateP.length + shift);
        for (let i = start; i < end; i++)
        {
            sum += (referenceP[i] - candidateP[i - shift]) ** 2;
            count++;
        }
        if (count > 0) best = Math.min(best, Math.sqrt(sum / count));
    }
    return best;
}

// Spectral centroid (Hz) over the shared DFT bin grid.
export function spectralCentroid(samples, sampleRate)
{
    const {mags, binToHz} = magnitudeSpectrum(samples, sampleRate);
    let weighted = 0, magnitude = 0;
    for (let k = 1; k < mags.length; k++)
    {
        weighted += binToHz(k) * mags[k];
        magnitude += mags[k];
    }
    return magnitude ? weighted / magnitude : 0;
}

// Correlation between fixed-time-frame RMS energy envelopes.
export function envelopeCorrelation(a, b, frameCount = 32)
{
    function envelope(samples)
    {
        const frameSize = Math.max(1, Math.floor(samples.length / frameCount));
        const env = [];
        for (let f = 0; f < frameCount; f++)
        {
            let sum = 0, count = 0;
            for (let i = f * frameSize; i < Math.min(samples.length, (f + 1) * frameSize); i++)
            { sum += samples[i] ** 2; count++; }
            env.push(count ? Math.sqrt(sum / count) : 0);
        }
        return env;
    }
    const ea = envelope(a), eb = envelope(b);
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < ea.length; i++) { dot += ea[i] * eb[i]; na += ea[i] ** 2; nb += eb[i] ** 2; }
    return dot / (Math.sqrt(na * nb) || 1);
}
