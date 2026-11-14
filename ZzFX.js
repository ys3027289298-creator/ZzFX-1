/*

ZzFX - Zuper Zmall Zound Zynth v1.4.0 by Frank Force
https://github.com/KilledByAPixel/ZzFX

ZzFX Features

- Tiny synth engine with 20 controllable parameters.
- Play sounds via code, no need for sound assed files!
- Compatible with most modern web browsers.
- Small code footprint, the micro version is under 1 kilobyte.
- Can produce a huge variety of sound effect types.
- Sounds can be played with a short call. zzfx(...[,,,,.1,,,,9])
- A small bit of randomness appied to sounds when played.
- Use ZZFX.GetNote to get frequencies on a standard diatonic scale.
- Sounds can be saved out as wav files for offline playback.
- No additional libraries or dependencies are required.

*/
/*

  ZzFX MIT License
  
  Copyright (c) 2019 - Frank Force
  
  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:
  
  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.
  
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
  
*/

'use strict';

// play a zzfx sound
export function zzfx(...parameters) { return ZZFX.play(...parameters) }

///////////////////////////////////////////////////////////////////////////////
// ZZFX filter toolkit - first/second order lowpass, highpass, and bandpass

// maximum allowed filter quality factor, above this the poles sit so close
// to the unit circle that the filter is useless in practice
const ZZFXFilterMaxQ = 100;

// valid filter types
const ZZFXFilterTypes = ['lowpass', 'highpass', 'bandpass'];

// Compute coefficients for a first or second order filter, returns
// [b0, b1, b2, a1, a2] for y = b2*x2 + b1*x1 + b0*x - a2*y2 - a1*y1.
// Pass filter as an object to buildSamples to use these filters, for example
// zzfx(...[,,,,,,,,,,,,,,,,,,,,,{type:'lowpass', frequency:500, q:2, order:2}])
// - type: 'lowpass' (default), 'highpass', or 'bandpass'
// - frequency: cutoff/center frequency in hz, must be in (0, sampleRate/2)
// - q: quality factor, must be in (0, ZZFXFilterMaxQ], default is 1/sqrt(2)
// - order: 1 or 2 (default), bandpass requires order 2, q only affects order 2
//
// Stability proof (all poles strictly inside the unit circle):
// Second order: denominator 1 + a1 z^-1 + a2 z^-2 with
//   a1 = -2 cos(w)/(1+alpha), a2 = (1-alpha)/(1+alpha),
//   w = 2*PI*frequency/sampleRate in (0, PI), alpha = sin(w)/(2*q) > 0.
//   Jury stability criteria for 1 + a1 z^-1 + a2 z^-2 are
//   1) 1 - a2      = 2 alpha/(1+alpha)     > 0 because alpha > 0
//   2) 1 + a1 + a2 = 2 (1-cos w)/(1+alpha) > 0 because w < PI so cos w < 1
//   3) 1 - a1 + a2 = 2 (1+cos w)/(1+alpha) > 0 because w > 0 so cos w > -1
//   All three hold, so both poles satisfy |p| < 1. For complex poles the
//   radius is |p| = sqrt(a2) = sqrt((1-alpha)/(1+alpha)) < 1.
// First order: single pole at p = (1-k)/(1+k) with k = tan(PI*f/fs) > 0,
//   so |p| = |1-k|/(1+k) < 1.
// The validation below guarantees w in (0, PI) and q in (0, ZZFXFilterMaxQ],
// so the premises always hold and the filter can never diverge.
function ZZFXFilterCoefficients(settings, sampleRate)
{
    const type = settings.type == undefined ? 'lowpass' : settings.type,
        frequency = settings.frequency,
        q = settings.q == undefined ? Math.SQRT1_2 : settings.q,
        order = settings.order == undefined ? 2 : settings.order;

    // validate parameters so the stability proof premises hold
    if (!ZZFXFilterTypes.includes(type))
        throw new TypeError('ZZFX filter type must be "lowpass", "highpass", or "bandpass", got "' + type + '"');
    if (!(frequency > 0 && frequency < sampleRate/2))
        throw new RangeError('ZZFX filter frequency must be between 0 and ' + sampleRate/2 + ' hz (nyquist), got ' + frequency);
    if (order != 1 && order != 2)
        throw new RangeError('ZZFX filter order must be 1 or 2, got ' + order);
    if (type == 'bandpass' && order == 1)
        throw new RangeError('ZZFX bandpass filter requires order 2');
    if (order == 2 && !(q > 0 && q <= ZZFXFilterMaxQ))
        throw new RangeError('ZZFX filter q must be between 0 (exclusive) and ' + ZZFXFilterMaxQ + ' (inclusive), got ' + q);

    if (order == 1)
    {
        // first order, bilinear transform of analog prototype, k = tan(w/2)
        const k = Math.tan(Math.PI*frequency/sampleRate), k1 = 1/(1+k);
        return type == 'lowpass' ?
            [k*k1, k*k1, 0, (k-1)*k1, 0] : // lowpass
            [k1, -k1, 0, (k-1)*k1, 0];     // highpass
    }

    // second order RBJ biquad, all types share the same denominator (poles)
    const w = 2*Math.PI*frequency/sampleRate,
        cos = Math.cos(w), alpha = Math.sin(w)/(2*q), a0 = 1/(1+alpha),
        a1 = -2*cos*a0, a2 = (1-alpha)*a0;
    return type == 'lowpass' ?
        [(1-cos)/2*a0, (1-cos)*a0, (1-cos)/2*a0, a1, a2] :
        type == 'highpass' ?
        [(1+cos)/2*a0, -(1+cos)*a0, (1+cos)/2*a0, a1, a2] :
        [alpha*a0, 0, -alpha*a0, a1, a2]; // bandpass, constant 0 db peak gain
}

///////////////////////////////////////////////////////////////////////////////
// ZZFX API for playing sounds
export const ZZFX =
{
    // master volume scale
    volume: .3,
    
    // sample rate for audio
    sampleRate: 44100,
    
    // create shared audio context
    audioContext: new AudioContext,

    // play a sound from zzfx paramerters
    play: function(...parameters)
    {
        // build samples and start sound
        return this.playSamples([this.buildSamples(...parameters)]);
    },

    // play an array of samples
    playSamples: function(sampleChannels, volumeScale=1, rate=1, pan=0, loop=false)
    {
        // create buffer and source
        const channelCount = sampleChannels.length;
        const sampleLength = sampleChannels[0].length;
        const buffer = this.audioContext.createBuffer(channelCount, sampleLength, this.sampleRate);
        const source = this.audioContext.createBufferSource();

        // copy samples to buffer and setup source
        sampleChannels.forEach((c,i)=> buffer.getChannelData(i).set(c));
        source.buffer = buffer;
        source.playbackRate.value = rate;
        source.loop = loop;

        // create and connect gain node
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = this.volume*volumeScale;
        gainNode.connect(this.audioContext.destination);
        source.gainNode = gainNode; // expose so callers can adjust or fade

        // connect source to stereo panner and gain
        const pannerNode = new StereoPannerNode(this.audioContext, {'pan':pan});
        source.connect(pannerNode).connect(gainNode);
        source.start();

        // return sound
        return source;
    },

    // build an array of samples
    buildSamples: function
    (
        volume = 1, 
        randomness = .05,
        frequency = 220,
        attack = 0,
        sustain = 0,
        release = .1,
        shape = 0,
        shapeCurve = 1,
        slide = 0, 
        deltaSlide = 0, 
        pitchJump = 0, 
        pitchJumpTime = 0, 
        repeatTime = 0, 
        noise = 0,
        modulation = 0,
        bitCrush = 0,
        delay = 0,
        sustainVolume = 1,
        decay = 0,
        tremolo = 0,
        filter = 0
    )
    {
        // init parameters
        let sampleRate = this.sampleRate,
            PI2 = Math.PI*2, 
            abs = Math.abs, 
            sign = v => v<0?-1:1, 
            startSlide = slide *= 500 * PI2 / sampleRate / sampleRate,
            startFrequency = frequency *= 
                (1 + randomness*2*Math.random() - randomness) * PI2 / sampleRate,
            modOffset = 0, // modulation offset  
            repeat = 0,    // repeat offset
            crush = 0,     // bit crush offset
            jump = 1,      // pitch jump timer
            length,        // sample length
            b,             // sample buffer
            t = 0,         // sample time
            i = 0,         // sample index 
            s = 0,         // sample value
        f,             // wave frequency

        // biquad LP/HP filter
        quality = 2, w = PI2 * abs(filter) * 2 / sampleRate,
        cos = Math.cos(w), alpha = Math.sin(w) / 2 / quality,
        a0 = 1 + alpha, a1 = -2*cos / a0, a2 = (1 - alpha) / a0,
        b0 = (1 + sign(filter) * cos) / 2 / a0, 
        b1 = -(sign(filter) + cos) / a0, b2 = b0,
        x2 = 0, x1 = 0, y2 = 0, y1 = 0;

        // setup filter, a number uses the legacy biquad above, an object
        // uses a first/second order lowpass/highpass/bandpass filter
        let fb0=0, fb1=0, fb2=0, fa1=0, fa2=0, // object filter coefficients
            fx1=0, fx2=0, fy1=0, fy2=0,        // object filter state
            filterObject = filter && typeof filter == 'object';
        if (filterObject)
            [fb0, fb1, fb2, fa1, fa2] = ZZFXFilterCoefficients(filter, sampleRate);
        else if (filter && !(abs(filter) < sampleRate/4))
            // the legacy biquad is only stable while its normalized cutoff
            // w = 2*PI2*|filter|/sampleRate stays in (0, PI), outside that
            // range its poles leave the unit circle and the output diverges
            throw new RangeError('ZZFX filter cutoff must be between 0 and ' +
                sampleRate/4 + ' hz, got ' + filter);

        // scale by sample rate
        const minAttack = 9; // prevent pop if attack is 0
        attack = attack * sampleRate || minAttack;
        decay *= sampleRate;
        sustain *= sampleRate;
        release *= sampleRate;
        delay *= sampleRate;
        deltaSlide *= 500 * PI2 / sampleRate**3;
        modulation *= PI2 / sampleRate;
        pitchJump *= PI2 / sampleRate;
        pitchJumpTime *= sampleRate;
        repeatTime = repeatTime * sampleRate | 0;

        // allocate the full sample buffer up front, much faster than growing an array
        length = attack + decay + sustain + release + delay | 0;
        b = new Float32Array(length > 0 ? length : 0);

        // generate waveform
        for(; i < length; b[i++] = s * volume)                 // sample
        {
            if (!(++crush%(bitCrush*100|0)))                   // bit crush
            {
                s = shape? shape>1? shape>2? shape>3? shape>4? // wave shape
                    (t/PI2%1 < shapeCurve/2? 1 : -1) :         // 5 square duty
                    Math.sin(t**3) :                           // 4 noise
                    Math.max(Math.min(Math.tan(t),1),-1):      // 3 tan
                    1-(2*t/PI2%2+2)%2:                         // 2 saw
                    1-4*abs(Math.round(t/PI2)-t/PI2):          // 1 triangle
                    Math.sin(t);                               // 0 sin

                s = (repeatTime ?
                        1 - tremolo + tremolo*Math.sin(PI2*i/repeatTime) // tremolo
                        : 1) *
                    (shape>4?s:sign(s)*abs(s)**shapeCurve) * // shape curve
                    (i < attack ? i/attack :                 // attack
                    i < attack + decay ?                     // decay
                    1-((i-attack)/decay)*(1-sustainVolume) : // decay falloff
                    i < attack  + decay + sustain ?          // sustain
                    sustainVolume :                          // sustain volume
                    i < length - delay ?                     // release
                    (length - i - delay)/release *           // release falloff
                    sustainVolume :                          // release volume
                    0);                                      // post release

                s = delay ? s/2 + (delay > i ? 0 :           // delay
                    (i<length-delay? 1 : (length-i)/delay) * // release delay 
                    b[i-delay|0]/2/volume) : s;              // sample delay

                if (filter)                                  // apply filter
                    s = filterObject ?                       // object filter
                    fy1 = fb2*fx2 + fb1*(fx2=fx1) + fb0*(fx1=s) - fa2*fy2 - fa1*(fy2=fy1) :
                    y1 = b2*x2 + b1*(x2=x1) + b0*(x1=s) - a2*y2 - a1*(y2=y1);
            }

            f = (frequency += slide += deltaSlide) *// frequency
                Math.cos(modulation*modOffset++);   // modulation
            t += f + f*noise*(i*i*PI2%2-1);         // noise

            if (jump && ++jump > pitchJumpTime)     // pitch jump
            { 
                frequency += pitchJump;             // apply pitch jump
                startFrequency += pitchJump;        // also apply to start
                jump = 0;                           // stop pitch jump time
            } 

            if (repeatTime && !(++repeat % repeatTime)) // repeat
            { 
                frequency = startFrequency;   // reset frequency
                slide = startSlide;           // reset slide
                jump ||= 1;                   // reset pitch jump time
            }
        }

        return b; // return sample buffer
    },

    // get frequency of a musical note on a diatonic scale
    getNote: function(semitoneOffset=0, rootNoteFrequency=440)
    {
        return rootNoteFrequency * 2**(semitoneOffset/12);
    }
}

///////////////////////////////////////////////////////////////////////////////
// Sound object that can precache and play ZZFX sounds
export class ZZFXSound
{
    constructor(zzfxSound=[])
    {
        this.zzfxSound = zzfxSound;
        
        // extract randomness parameter from zzfxSound
        this.randomness = zzfxSound[1] != undefined ? zzfxSound[1] : .05;
        zzfxSound[1] = 0; // generate without frequency randomness
        
        // cache the sound samples
        this.samples = ZZFX.buildSamples(...zzfxSound);
    }

    play(volume=1, pitch=1, randomnessScale=1, pan=0, loop=false)
    {
        if (!this.samples) return;

        // play the sound
        const playbackRate = pitch + pitch * this.randomness*randomnessScale*(Math.random()*2-1);
        this.source = ZZFX.playSamples([this.samples], volume, playbackRate, pan, loop);
        return this.source;
    }
}
