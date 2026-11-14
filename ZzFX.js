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
// Pluggable processing chain
//
// The three signal-processing passes that used to be interleaved inside the
// buildSamples loop (envelope/delay, slide/phase and the biquad filter) are
// now independent stages implementing one shared interface:
//
//   stage.name      stable identifier string
//   stage.enabled   when false the stage is bypassed and never runs, so its
//                   internal state is frozen for the whole render
//   stage.process(ctx)  transform the current sample ctx.s in place
//   stage.snapshot()    plain object copy of the stage's internal state
//
// Stages communicate only through the per-voice context object; each stage
// owns disjoint closure state, so enabling or disabling one stage cannot
// mutate another stage's internal state.

// identifiers of the pluggable stages, default order matches the original
// interleaved loop exactly: envelope -> filter -> slide
const ZZFX_DEFAULT_CHAIN_ORDER = Object.freeze(['envelope', 'filter', 'slide']);
const ZZFX_CHAIN_STAGE_NAMES = ZZFX_DEFAULT_CHAIN_ORDER;

// build a configured chain of processing stages
//
// order:   permutation of 'envelope', 'filter' and 'slide'
// enabled: map of stage name -> boolean (stages missing from the map default
//          to enabled)
//
// throws TypeError on a non-array order, unknown/duplicate/missing stage
// names or non-boolean enabled flags.
function zzfxCreateChain(scope, order = ZZFX_DEFAULT_CHAIN_ORDER, enabled = {})
{
    if (!Array.isArray(order))
        throw new TypeError(`ZzFX chain order must be an array, got ${typeof order}`);

    if (order.length != ZZFX_CHAIN_STAGE_NAMES.length
        || order.some(stageName => !ZZFX_CHAIN_STAGE_NAMES.includes(stageName))
        || new Set(order).size != order.length)
    {
        throw new TypeError(
            `ZzFX chain order must be a permutation of [${ZZFX_CHAIN_STAGE_NAMES.join(', ')}], got [${order.join(', ')}]`);
    }

    if (enabled === null || typeof enabled != 'object')
        throw new TypeError(`ZzFX chain enabled map must be an object, got ${typeof enabled}`);

    for (const stageName in enabled)
    {
        if (!ZZFX_CHAIN_STAGE_NAMES.includes(stageName))
            throw new TypeError(`ZzFX chain enabled map has unknown stage '${stageName}'`);
        if (typeof enabled[stageName] != 'boolean')
            throw new TypeError(`ZzFX chain enabled flag for '${stageName}' must be a boolean, got ${typeof enabled[stageName]}`);
    }

    // one factory per stage name; each factory closes over exactly the same
    // locals the original loop mutated, preserving its arithmetic verbatim
    const stageFactories =
    {
        // amplitude envelope (attack/decay/sustain/release) plus sample delay
        envelope: scope =>
        {
            const {
                volume, attack, decay, sustain, sustainVolume, length,
                release, delay, b
            } = scope;
            const state = { calls: 0, delayMixSamples: 0 };
            return {
                name: 'envelope',
                enabled: true,
                process(ctx)
                {
                    state.calls++;

                    const tremoloFactor = scope.repeatTime ?
                            1 - scope.tremolo + scope.tremolo*Math.sin(scope.PI2*ctx.i/scope.repeatTime) : 1,
                        shapeFactor = scope.shape > 4 ? ctx.s : scope.sign(ctx.s)*scope.abs(ctx.s)**scope.shapeCurve,
                        envelopeFactor = ctx.i < attack ? ctx.i/attack :
                        ctx.i < attack + decay ?
                        1-((ctx.i-attack)/decay)*(1-sustainVolume) :
                        ctx.i < attack  + decay + sustain ?
                        sustainVolume :
                        ctx.i < length - delay ?
                        (length - ctx.i - delay)/release * sustainVolume :
                        0;

                    ctx.s = tremoloFactor * shapeFactor * envelopeFactor;

                    if (delay)
                    {
                        ctx.s = ctx.s/2 + (delay > ctx.i ? 0 :
                            (ctx.i<length-delay? 1 : (length-ctx.i)/delay) *
                            b[ctx.i-delay|0]/2/volume);
                        state.delayMixSamples++;
                    }
                },
                snapshot: () => ({ ...state })
            };
        },

        // biquad low/high pass filter, carries the original x1/x2/y1/y2 taps
        filter: scope =>
        {
            const state = { calls: 0, x1: 0, x2: 0, y1: 0, y2: 0 };
            return {
                name: 'filter',
                enabled: true,
                process(ctx)
                {
                    // original loop only filtered when the filter param is set
                    if (!scope.filter)
                        return;

                    state.calls++;
                    state.y1 = scope.b2*state.x2 + scope.b1*(state.x2=state.x1) +
                        scope.b0*(state.x1=ctx.s) - scope.a2*state.y2 - scope.a1*(state.y2=state.y1);
                    ctx.s = state.y1;
                },
                snapshot: () => ({ ...state })
            };
        },

        // slide, delta slide, modulation/noise phase advance and pitch jumps
        slide: scope =>
        {
            const state =
            {
                calls: 0,
                frequency: scope.frequency,
                slide: scope.slide,
                t: scope.t,
                modOffset: scope.modOffset,
                jump: scope.jump,
                repeat: scope.repeat
            };
            return {
                name: 'slide',
                enabled: true,
                process(ctx)
                {
                    state.calls++;

                    ctx.f = (state.frequency += state.slide += scope.deltaSlide) *
                        Math.cos(scope.modulation*state.modOffset++);
                    state.t += ctx.f + ctx.f*scope.noise*(ctx.i*ctx.i*scope.PI2%2-1);

                    if (state.jump && ++state.jump > scope.pitchJumpTime)
                    {
                        state.frequency += scope.pitchJump;
                        scope.startFrequency += scope.pitchJump;
                        state.jump = 0;
                    }

                    if (scope.repeatTime && !(++state.repeat % scope.repeatTime))
                    {
                        state.frequency = scope.startFrequency;
                        state.slide = scope.startSlide;
                        state.jump ||= 1;
                    }

                    ctx.t = state.t;
                },
                snapshot: () => ({ ...state })
            };
        }
    };

    return order.map(stageName =>
    {
        const stage = stageFactories[stageName](scope);
        stage.enabled = enabled[stageName] !== false;
        return stage;
    });
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
        filter = 0,
        // optional processing chain configuration; when omitted the stages
        // run in the original order with every stage enabled
        chainOptions = null
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
            f = 0,         // wave frequency

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

        // build the pluggable processing chain (default order reproduces the
        // original interleaved loop exactly)
        if (chainOptions !== null && (typeof chainOptions != 'object' || Array.isArray(chainOptions)))
            throw new TypeError(`ZzFX chainOptions must be an object, got ${Array.isArray(chainOptions) ? 'array' : typeof chainOptions}`);

        // shared closure view of the locals every stage was originally mutating
        const stageScope = {
            PI2, abs, sign,
            shape, shapeCurve, tremolo, repeatTime,
            attack, decay, sustain, sustainVolume, length, release, delay,
            volume, b,
            filter, a1, a2, b0, b1, b2,
            frequency, slide, deltaSlide, modulation, noise, t, modOffset,
            jump, repeat, startFrequency, startSlide,
            pitchJump, pitchJumpTime
        };
        const chain = zzfxCreateChain(
            stageScope,
            chainOptions?.order,
            chainOptions?.enabled);

        // per-voice context shared between stages for the current sample
        const chainContext = { i: 0, s: 0, f: 0, t: 0 };

        // generate waveform
        for(; i < length; b[i++] = s * volume)                 // sample
        {
            // the bit-crush gate wraps the waveform + envelope + filter
            // passes exactly as it did in the original loop
            const crushGateOpen = !(++crush%(bitCrush*100|0));  // bit crush
            if (crushGateOpen)
            {
                s = shape? shape>1? shape>2? shape>3? shape>4? // wave shape
                    (t/PI2%1 < shapeCurve/2? 1 : -1) :         // 5 square duty
                    Math.sin(t**3) :                           // 4 noise
                    Math.max(Math.min(Math.tan(t),1),-1):      // 3 tan
                    1-(2*t/PI2%2+2)%2:                         // 2 saw
                    1-4*abs(Math.round(t/PI2)-t/PI2):          // 1 triangle
                    Math.sin(t);                               // 0 sin
            }

            // run the enabled stages in configured order; the envelope and
            // filter passes only act on samples admitted by the crush gate,
            // while the slide/phase stage advances on every sample
            chainContext.i = i;
            chainContext.s = s;
            chainContext.f = f;
            chainContext.t = t;
            for (const stage of chain)
            {
                if (!stage.enabled)
                    continue;
                if (!crushGateOpen &&
                    (stage.name == 'envelope' || stage.name == 'filter'))
                    continue;
                stage.process(chainContext);
            }
            s = chainContext.s;
            f = chainContext.f;
            t = chainContext.t;
        }

        // publish internal-state snapshots of every stage when requested
        if (chainOptions?.snapshotHolder)
            chainOptions.snapshotHolder.snapshots =
                Object.fromEntries(chain.map(stage => [stage.name, stage.snapshot()]));

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
