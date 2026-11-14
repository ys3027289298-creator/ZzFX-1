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
// Chain-level gain node.
// A gain node can be inserted at any point of the synthesis chain; gain
// parameter changes are applied with per-sample linear ramps so no step
// discontinuity is ever produced, and a muted node lets the engine skip all
// downstream sample computation instead of multiplying by zero at the end.
export class ZZFXGainNode
{
    // positions a gain node may be inserted at, in chain order
    static POSITION = Object.freeze({
        PRE_DELAY:  0, // before the delay/feedback stage
        POST_DELAY: 1, // after the delay/feedback stage
        PRE_FILTER: 2, // before the biquad filter
        POST_FILTER:3, // after the biquad filter
        OUTPUT:     4  // final output scale (where the sound volume lives)
    });

    // default ramp length in samples used when no duration is supplied
    static defaultRampSamples = 256;

    constructor(gain = 1, position = ZZFXGainNode.POSITION.OUTPUT)
    {
        this.setPosition(position);
        this._gain = ZZFXGainNode._validateGain(gain);
        this._muted = false;
        this._events = [];          // scheduled {sample, target, rampSamples}
        this._heldGain = this._gain;
        this._eventIndex = 0;
        this._rampFrom = this._gain;
        this._rampTo = this._gain;
        this._rampStart = 0;
        this._rampDuration = 0;
        this._isStatic = true;      // no ramps/events => constant multiply
    }

    static _validateGain(gain)
    {
        if (typeof gain !== 'number' || !isFinite(gain))
            throw new TypeError(`ZZFXGainNode: gain must be a finite number, got ${String(gain)}`);
        return gain;
    }

    setPosition(position)
    {
        let valid = false;
        for (const key in ZZFXGainNode.POSITION)
            if (ZZFXGainNode.POSITION[key] === position) valid = true;
        if (!valid)
            throw new RangeError(`ZZFXGainNode: invalid position ${String(position)}`);
        this.position = position;
        return this;
    }

    get gain() { return this._gain; }

    // assigning a constant gain keeps the node static (zero per-sample cost)
    set gain(gain)
    {
        this._gain = ZZFXGainNode._validateGain(gain);
        this._heldGain = this._gain;
        this._events.length = 0;
        this._eventIndex = 0;
        this._rampFrom = this._gain;
        this._rampTo = this._gain;
        this._rampDuration = 0;
        this._isStatic = true;
    }

    get muted() { return this._muted; }

    set muted(muted)
    {
        this._muted = !!muted;
        this.reset(); // a muted node always emits silence, state is irrelevant
    }

    // schedule a ramped gain change starting at sample offset; the first ramp
    // sample equals the current held value, so the transition has no step
    rampGainAt(target, sample = 0, rampSamples = ZZFXGainNode.defaultRampSamples)
    {
        target = ZZFXGainNode._validateGain(target);
        sample |= 0;
        if (sample < 0)
            throw new RangeError(`ZZFXGainNode: sample offset must be >= 0, got ${sample}`);
        rampSamples |= 0;
        if (rampSamples < 0)
            throw new RangeError(`ZZFXGainNode: rampSamples must be >= 0, got ${rampSamples}`);
        this._events.push({sample, target, rampSamples});
        this._events.sort((a, b) => a.sample - b.sample);
        this._isStatic = false;
        return this;
    }

    // immediate ramped change applied at the next generated sample
    rampGain(target, rampSamples = ZZFXGainNode.defaultRampSamples)
    {
        return this.rampGainAt(target, 0, rampSamples);
    }

    // reset per-render state; called once before each build
    reset()
    {
        this._eventIndex = 0;
        this._heldGain = this._gain;
        this._rampFrom = this._gain;
        this._rampTo = this._gain;
        this._rampStart = 0;
        this._rampDuration = 0;
    }

    // true when this node emits a constant value for the whole render
    get staticGain()
    {
        return this._isStatic || this._muted;
    }

    // constant emitted value; only valid when staticGain is true
    get constantGain()
    {
        return this._muted ? 0 : this._heldGain;
    }

    // gain emitted at sample index i (linear interpolation while ramping)
    valueAt(i)
    {
        if (this._muted)
            return 0;
        if (this._isStatic)
            return this._heldGain;

        // start any event whose time has come
        while (this._eventIndex < this._events.length &&
               this._events[this._eventIndex].sample <= i)
        {
            const event = this._events[this._eventIndex++];
            this._rampFrom = this._heldGain; // ramp from actual current value
            this._rampTo = event.target;
            this._rampStart = i;
            this._rampDuration = event.rampSamples;
        }

        if (i >= this._rampStart + this._rampDuration || this._rampDuration === 0)
        {
            this._heldGain = this._rampTo;
            return this._heldGain;
        }

        const v = this._rampFrom +
            (this._rampTo - this._rampFrom) *
            ((i - this._rampStart) / this._rampDuration);
        this._heldGain = v;
        return v;
    }
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

    // create a chain-level gain node that can be inserted at any position
    createGainNode: function(gain = 1, position = ZZFXGainNode.POSITION.OUTPUT)
    {
        return new ZZFXGainNode(gain, position);
    },

    // build samples through an explicit chain of gain nodes.
    // The parameters are identical to buildSamples; gainNodes is an array of
    // ZZFXGainNode instances placed at their declared positions. A muted node
    // (or a static zero gain) short-circuits all downstream computation.
    buildSamplesWithChain: function(parameters, gainNodes = [])
    {
        if (!Array.isArray(gainNodes))
            throw new TypeError('buildSamplesWithChain: gainNodes must be an array');

        // no chain requested: keep the original fast path bit-for-bit
        if (!gainNodes.length)
            return this.buildSamples(...parameters);

        for (const node of gainNodes)
        {
            if (!(node instanceof ZZFXGainNode))
                throw new TypeError('buildSamplesWithChain: every gain node must be a ZZFXGainNode');
            node.reset();
        }

        // nodes grouped by insertion position
        const nodesAt = [[], [], [], [], []];
        for (const node of gainNodes)
            nodesAt[node.position].push(node);

        // any constant zero/muted node makes the whole render silent; in that
        // case only the up-front buffer allocation remains, no synthesis work
        let fullyMuted = false;
        for (const node of gainNodes)
        {
            if (node.staticGain && node.constantGain === 0)
            {
                fullyMuted = true;
                break;
            }
        }

        // init parameters (mirrors buildSamples exactly)
        let sampleRate = this.sampleRate,
            PI2 = Math.PI*2, 
            abs = Math.abs, 
            sign = v => v<0?-1:1, 
            startSlide,
            startFrequency,
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
            volume = parameters[0] === undefined ? 1 : parameters[0],
            randomness = parameters[1] === undefined ? .05 : parameters[1],
            frequency = parameters[2] === undefined ? 220 : parameters[2],
            attack = parameters[3] === undefined ? 0 : parameters[3],
            sustain = parameters[4] === undefined ? 0 : parameters[4],
            release = parameters[5] === undefined ? .1 : parameters[5],
            shape = parameters[6] === undefined ? 0 : parameters[6],
            shapeCurve = parameters[7] === undefined ? 1 : parameters[7],
            slide = parameters[8] === undefined ? 0 : parameters[8], 
            deltaSlide = parameters[9] === undefined ? 0 : parameters[9], 
            pitchJump = parameters[10] === undefined ? 0 : parameters[10], 
            pitchJumpTime = parameters[11] === undefined ? 0 : parameters[11], 
            repeatTime = parameters[12] === undefined ? 0 : parameters[12], 
            noise = parameters[13] === undefined ? 0 : parameters[13],
            modulation = parameters[14] === undefined ? 0 : parameters[14],
            bitCrush = parameters[15] === undefined ? 0 : parameters[15],
            delay = parameters[16] === undefined ? 0 : parameters[16],
            sustainVolume = parameters[17] === undefined ? 1 : parameters[17],
            decay = parameters[18] === undefined ? 0 : parameters[18],
            tremolo = parameters[19] === undefined ? 0 : parameters[19],
            filter = parameters[20] === undefined ? 0 : parameters[20];

        startSlide = slide *= 500 * PI2 / sampleRate / sampleRate;
        startFrequency = frequency *= 
            (1 + randomness*2*Math.random() - randomness) * PI2 / sampleRate;

        // biquad LP/HP filter
        let quality = 2, w = PI2 * abs(filter) * 2 / sampleRate,
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

        // muted render: nothing to compute beyond the zero-filled allocation
        if (fullyMuted)
            return b;

        // multiply s by every node at one insertion position
        const applyNodes = (nodes, index, value) =>
        {
            for (const node of nodes)
                value *= node.staticGain ? node.constantGain : node.valueAt(index);
            return value;
        };

        // generate waveform (same arithmetic order as buildSamples)
        for(; i < length; i++)                                  // sample
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

                s = applyNodes(nodesAt[ZZFXGainNode.POSITION.PRE_DELAY], i, s);

                s = delay ? s/2 + (delay > i ? 0 :           // delay
                    (i<length-delay? 1 : (length-i)/delay) * // release delay 
                    b[i-delay|0]/2/volume) : s;              // sample delay

                s = applyNodes(nodesAt[ZZFXGainNode.POSITION.POST_DELAY], i, s);

                if (filter)                                  // apply filter
                {
                    s = applyNodes(nodesAt[ZZFXGainNode.POSITION.PRE_FILTER], i, s);
                    s = y1 = b2*x2 + b1*(x2=x1) + b0*(x1=s) - a2*y2 - a1*(y2=y1);
                    s = applyNodes(nodesAt[ZZFXGainNode.POSITION.POST_FILTER], i, s);
                }
            }

            // output stage runs for every sample (even held bit-crush samples)
            const out = applyNodes(nodesAt[ZZFXGainNode.POSITION.OUTPUT], i, s);
            b[i] = out * volume;

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
