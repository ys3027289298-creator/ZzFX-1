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
// Modulation effects (chorus & flanger) built on one shared bounded delay line

// hard upper bounds, so every legal configuration has a fixed memory ceiling
export const EFFECT_LIMITS = Object.freeze(
{
    maxDelaySeconds:  .1,    // delay + depth may never exceed this
    maxRateHz:        20,    // LFO modulation rate
    maxMix:           1,     // wet/dry mix
    maxFeedback:      .95,   // flanger feedback coefficient
    minSampleRate:    1,
    maxSampleRate:    384000
});

// default tuning: chorus uses long slow modulation, flanger short fast modulation
export const EFFECT_PRESETS = Object.freeze(
{
    chorus:  Object.freeze({ delaySeconds: .02, rateHz: 1,   depthSeconds: .008, mix: .5, feedback: 0  }),
    flanger: Object.freeze({ delaySeconds: .004, rateHz: 2, depthSeconds: .002, mix: .5, feedback: .4 })
});

// fixed-capacity circular delay line shared by both effects
export class DelayLine
{
    constructor(capacity)
    {
        if (!Number.isInteger(capacity) || capacity <= 0)
            throw new RangeError('DelayLine capacity must be a positive integer');

        this.capacity = capacity;
        this.buffer = new Float32Array(capacity); // bounded: never reallocated
        this.index = 0;
        this.memoryBytes = capacity * this.buffer.BYTES_PER_ELEMENT;
    }

    clear()
    {
        this.buffer.fill(0);
        this.index = 0;
    }

    write(sample)
    {
        this.buffer[this.index] = sample;
        this.index = (this.index + 1) % this.capacity;
    }

    // fractional read, delaySamples in [0, capacity - 1], linear interpolation
    read(delaySamples)
    {
        const whole = delaySamples | 0;
        const fraction = delaySamples - whole;
        const buffer = this.buffer;
        const capacity = this.capacity;
        const indexA = (this.index - 1 - whole + capacity * 2) % capacity;
        const indexB = (indexA - 1 + capacity) % capacity;
        return buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction;
    }
}

// validate and normalize an effect configuration, throws RangeError on bad input
export function validateEffectConfig(config, sampleRate)
{
    if (config === null || typeof config != 'object' || Array.isArray(config))
        throw new RangeError('Effect configuration must be an object');

    if (!Number.isFinite(sampleRate) ||
        sampleRate < EFFECT_LIMITS.minSampleRate ||
        sampleRate > EFFECT_LIMITS.maxSampleRate)
        throw new RangeError('sampleRate out of range');

    const type = config.type;
    if (type != 'chorus' && type != 'flanger')
        throw new RangeError(`Unknown effect type: ${type}`);

    const preset = EFFECT_PRESETS[type];
    const delaySeconds = config.delaySeconds ?? preset.delaySeconds;
    if (!Number.isFinite(delaySeconds) || delaySeconds <= 0 ||
        delaySeconds > EFFECT_LIMITS.maxDelaySeconds)
        throw new RangeError('delaySeconds out of range');

    const depthSeconds = config.depthSeconds ?? preset.depthSeconds;
    if (!Number.isFinite(depthSeconds) || depthSeconds < 0 ||
        depthSeconds > EFFECT_LIMITS.maxDelaySeconds)
        throw new RangeError('depthSeconds out of range');

    if (delaySeconds + depthSeconds > EFFECT_LIMITS.maxDelaySeconds)
        throw new RangeError(
            `delaySeconds + depthSeconds exceeds the ${EFFECT_LIMITS.maxDelaySeconds}s bound`);

    const rateHz = config.rateHz ?? preset.rateHz;
    if (!Number.isFinite(rateHz) || rateHz <= 0 || rateHz > EFFECT_LIMITS.maxRateHz)
        throw new RangeError('rateHz out of range');

    const mix = config.mix ?? preset.mix;
    if (!Number.isFinite(mix) || mix < 0 || mix > EFFECT_LIMITS.maxMix)
        throw new RangeError('mix out of range');

    const feedback = config.feedback ?? preset.feedback;
    if (!Number.isFinite(feedback) || feedback < 0 ||
        feedback > EFFECT_LIMITS.maxFeedback)
        throw new RangeError('feedback out of range');

    return {type, delaySeconds, depthSeconds, rateHz, mix, feedback, sampleRate};
}

// apply a chorus or flanger to a sample buffer; returns a new Float32Array
export function applyEffect(samples, config, sampleRate = 44100)
{
    if (!(samples instanceof Float32Array) || samples.length == 0)
        throw new RangeError('applyEffect requires a non-empty sample buffer');

    // disabled effect: bit-exact copy of the input, sample for sample
    if (!config || config.enabled === false)
        return samples.slice();

    const settings = validateEffectConfig(config, sampleRate);

    // bounded delay line: one spare sample keeps fractional reads in range
    const maxDelaySamples =
        (settings.delaySeconds + settings.depthSeconds) * sampleRate;
    const capacity = Math.ceil(maxDelaySamples) + 1;
    const delayLine = new DelayLine(capacity);

    const baseDelay = settings.delaySeconds * sampleRate;
    const depth = settings.depthSeconds * sampleRate;
    const phaseStep = 2 * Math.PI * settings.rateHz / sampleRate;
    const output = new Float32Array(samples.length);

    let phase = 0;
    for (let i = 0; i < samples.length; ++i)
    {
        const input = samples[i];
        const modulatedDelay = baseDelay + depth * Math.sin(phase);
        phase += phaseStep;

        const delayed = delayLine.read(modulatedDelay);
        let writeValue = input;
        if (settings.feedback)
            writeValue = input + settings.feedback * delayed;

        delayLine.write(writeValue);
        output[i] = input * (1 - settings.mix) + delayed * settings.mix;
    }

    return output;
}

///////////////////////////////////////////////////////////////////////////////
// ZZFX API for playing sounds
export const ZZFX =
{
    // master volume scale
    volume: .3,
    
    // sample rate for audio
    sampleRate: 44100,

    // apply a chorus or flanger modulation effect to a sample buffer
    applyEffect: function(samples, config)
    {
        return applyEffect(samples, config, this.sampleRate);
    },

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
                    s = y1 = b2*x2 + b1*(x2=x1) + b0*(x1=s) - a2*y2 - a1*(y2=y1);
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
