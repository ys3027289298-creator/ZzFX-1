// Shared battery of representative zzfx parameter arrays (randomness forced to 0).
// Covers all wave shapes, envelopes, slides, jumps, repeats, delay, filter,
// bit crush, modulation, tremolo and noise paths.
'use strict';

export const sounds =
[
    {name: 'sine_blip',       params: [1, 0, 440,  .01, .05, .1,  0, 1,    0,    0,   0,   0,    0, 0,    0,   0,   0,   1, 0, 0, 0], smooth: true},
    {name: 'saw_slide',       params: [1, 0, 660,  .005,.08, .15, 2, 1,  -120,   5,   0,   0,    0, 0,    0,   0,   0,   1, 0, 0, 0]},
    {name: 'square_jump',     params: [1, 0, 330,  .01, .1,  .12, 5, .5,    0,   0, 220, .08, .15, 0,    0,   0,   0,   1, 0, 0, 0]},
    {name: 'triangle_repeat', params: [1, 0, 523,  .01, .02, .22, 1, 1,     0,   0,   0,   0,  .09, 0,    0,   0,   0,   1, 0, 0, 0], smooth: true},
    {name: 'noise_hit',       params: [1, 0, 129,  .01, 0,   .15, 4, 1,     0,   0,   0,   0,    0, .3,   0,   0,   0,   1, 0, 0, 0], pitched: false},
    // tan wave + bit crusher + modulation: zero crossings track harmonics, so
    // pitch is validated via spectral centroid rather than zero-crossing rate
    {name: 'tan_mod_crush',   params: [1, 0, 270,  .01, .1,  .1,  3, 1.2,  30,  -2,   0,   0,    0, 0,  120,  .05, .04,  .9, 0, 6, 0], pitched: false},
    {name: 'delayed_filter',  params: [1, 0, 925,  .005,.08, .2,  0, 1,   -40,   0,   0,   0,    0, 0,    0,   0,  .08,  .8,.1,0,-800]},
    {name: 'tremolo_full',    params: [.8,0, 220,  .02, .1,  .25, 0, 1.5,  60,   0,  90, .12,  .06, .15, 80,    0,   0,   1,.05,.1,400]},
    // deterministic version of the all-defaults tone (randomness forced to 0)
    // so short-signal pitch can be compared strictly across sample rates
    {name: 'default_tone',     params: [1, 0, 220, 0, 0, .1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], smooth: true},
    // randomness path and the all-defaults call; run with a seeded Math.random
    // so the two engines consume the identical random sequence
    {name: 'randomized',      params: [1, .15, 392, .01, .06, .12, 2, 1, 40, 3, 50, .05, .08, .1, 60, .03, .05, .9, .04, .08, 300], seeded: true, pitched: false},
    {name: 'defaults',        params: [], seeded: true, pitched: false},
];
