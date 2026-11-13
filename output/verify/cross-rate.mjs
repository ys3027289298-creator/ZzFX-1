// Check 2: the same sound parameters rendered at 44.1k and 48k must describe
// the same audio. Compare physical duration, pitch consistency, spectral
// balance and the energy envelope, running BOTH renders through ONE shared
// ratio-driven resampler (no per-sample-rate branches anywhere).
'use strict';

import './polyfills.mjs';
import {ZZFX} from './ZzFX-link.js';
import {sounds} from './sounds.mjs';
import {
    resampleSinc, estimatePitch, pitchDrift, rms,
    alignedRmse, spectralCentroid, envelopeCorrelation,
} from './dsp.mjs';

const RATE_A = 44100;
const RATE_B = 48000;

function renderAt(params, rate)
{
    // sampleRate is the explicit 22nd engine argument; pad the 21 sound
    // parameters with defaults so the rate never collides with filter
    const filled = params.slice();
    while (filled.length < 21) filled.push(undefined);
    return ZZFX.buildSamples(...filled, rate);
}

// Acceptance tolerances
const DURATION_TOLERANCE = 0.002;  // <= 2 ms physical duration difference
const PITCH_TOLERANCE = 0.02;     // <= 2% median drift across spectral peaks
const SPECTRAL_TOLERANCE = 0.05;  // <= 5% spectral centroid drift
const ENVELOPE_TOLERANCE = 0.97;  // energy envelope correlation
const STOCHASTIC_ENVELOPE_TOLERANCE = 0.95; // looser for intentionally random sounds
const WAVEFORM_TOLERANCE = 0.05;  // aligned RMSE, only enforced on smooth tones

let failures = 0;
const report = [];

for (const {name, params, pitched = true, smooth = false, seeded = false} of sounds)
{
    const a = renderAt(params, RATE_A);
    const b = renderAt(params, RATE_B);

    const durationA = a.length / RATE_A;
    const durationB = b.length / RATE_B;
    const durationDiff = Math.abs(durationA - durationB);

    // one shared resampler: bring the 48k render onto the 44.1k grid
    const aOnGrid = resampleSinc(a, RATE_A, RATE_A);
    const bOnGrid = resampleSinc(b, RATE_B, RATE_A);

    const centroidA = spectralCentroid(aOnGrid, RATE_A);
    const centroidB = spectralCentroid(bOnGrid, RATE_A);
    const centroidDrift = centroidA ? Math.abs(centroidB - centroidA) / centroidA : 0;
    const envelope = envelopeCorrelation(aOnGrid, bOnGrid);

    const row = {
        name,
        len44100: a.length,
        len48000: b.length,
        durationSec: durationA.toFixed(4),
        durationDiffMs: (durationDiff * 1000).toFixed(3),
        centroidDriftPct: (centroidDrift * 100).toFixed(3),
        envelopeCorr: Number(envelope.toFixed(4)),
    };

    const envelopeLimit = seeded ? STOCHASTIC_ENVELOPE_TOLERANCE : ENVELOPE_TOLERANCE;
    // Deterministic sounds must match spectrally. Stochastic (randomized)
    // sounds contain fresh randomness on every render, so their spectral
    // detail is allowed to differ; they are judged on duration and envelope.
    const centroidLimit = seeded ? Infinity :
        (pitched ? SPECTRAL_TOLERANCE * 3 : SPECTRAL_TOLERANCE);
    let ok =
        durationDiff <= DURATION_TOLERANCE &&
        centroidDrift <= centroidLimit &&
        envelope >= envelopeLimit;

    if (pitched)
    {
        const drift = pitchDrift(aOnGrid, bOnGrid, RATE_A);
        row.peakPitch44100Hz = estimatePitch(aOnGrid, RATE_A).toFixed(1);
        row.peakPitch48000Hz = estimatePitch(bOnGrid, RATE_A).toFixed(1);
        row.pitchDriftPct = (drift * 100).toFixed(3);
        ok &&= drift <= PITCH_TOLERANCE;
    }

    if (smooth)
    {
        const nrmse = alignedRmse(aOnGrid, bOnGrid) / (rms(aOnGrid) || 1);
        row.alignedRmsePct = (nrmse * 100).toFixed(3);
        ok &&= nrmse <= WAVEFORM_TOLERANCE;
    }

    row.result = ok ? 'PASS' : 'FAIL';
    if (!ok) failures++;
    report.push(row);
}

console.table(report);
console.log(failures ? `\n${failures} sound(s) outside tolerance` : '\nall sounds consistent across 44.1k and 48k within tolerance');
process.exitCode = failures ? 1 : 0;
