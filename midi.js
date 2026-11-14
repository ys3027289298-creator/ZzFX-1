// midi.js by Frank Force - https://github.com/KilledByAPixel/ZzFX
// export a zzfx sound as a standard MIDI file (SMF type 0) for DAW editing

// parameter mapping:
//   frequency                     -> note number (plus user pitch offset in semitones)
//   attack+decay+sustain+release  -> note duration (timeline set by user tempo in BPM)
//   volume                        -> note velocity
//   slide, deltaSlide             -> pitch bend curve (assumes +/-2 semitone bend range)
//   sustainVolume                 -> CC11 expression
// anything else that is active has no MIDI equivalent and is reported as a
// diagnostic instead of being silently dropped

export const midiPPQ = 480; // pulses per quarter note

// analyze a sound and build the MIDI event list, returns events and diagnostics
export function buildMidiData(sound, {bpm = 120, pitchOffset = 0} = {})
{
    const diagnostics = [];
    const events = []; // {tick, data:[...]}
    const emit = (tick, ...data) => events.push({tick, data});

    // note number from frequency, A4 = 69 = 440 Hz
    let frequency = sound.frequency;
    if (!(frequency > 0))
    {
        diagnostics.push(`frequency ${frequency}: not a positive pitch, exported as 1 Hz`);
        frequency = 1;
    }
    let note = Math.round(69 + 12*Math.log2(frequency/440)) + pitchOffset|0;
    const noteClamped = Math.min(127, Math.max(0, note));
    if (note != noteClamped)
        diagnostics.push(`note ${note} is outside MIDI range 0-127, clamped to ${noteClamped}`);
    note = noteClamped;

    // velocity from volume (1 = 100%)
    let velocity = Math.round(sound.volume*127);
    const velocityClamped = Math.min(127, Math.max(1, velocity));
    if (velocity != velocityClamped)
        diagnostics.push(`volume ${sound.volume}: velocity ${velocity} outside 1-127, clamped to ${velocityClamped}`);
    velocity = velocityClamped;

    // note duration from envelope times, timeline scaled by tempo
    const durationSeconds = sound.attack + sound.decay + sound.sustain + sound.release;
    let durationTicks = Math.round(durationSeconds * bpm/60 * midiPPQ);
    if (durationTicks < 1)
    {
        diagnostics.push(`envelope duration ${durationSeconds}s is too short for a MIDI note, using 1 tick`);
        durationTicks = 1;
    }

    // expression from sustain volume
    if (sound.sustainVolume != 1)
    {
        const expression = Math.min(127, Math.max(0, Math.round(sound.sustainVolume*127)));
        if (expression != sound.sustainVolume*127)
            diagnostics.push(`sustainVolume ${sound.sustainVolume}: expression clamped to ${expression}`);
        emit(0, 0xB0, 11, expression);
    }

    // pitch bend curve from slide and deltaSlide (kHz/s and kHz/s/s)
    if (sound.slide || sound.deltaSlide)
    {
        const bendRange = 2; // assumed +/-2 semitone pitch bend range
        const steps = Math.min(64, Math.max(2, Math.round(durationSeconds*20)));
        let exceeded = 0;
        for (let i = 0; i <= steps; ++i)
        {
            const time = durationSeconds * i/steps;
            const f = Math.max(1, frequency + 1e3*(sound.slide*time + sound.deltaSlide*time*time/2));
            const semitones = 12*Math.log2(f/frequency);
            if (Math.abs(semitones) > bendRange)
                exceeded = Math.max(exceeded, Math.abs(semitones));
            const bend = Math.min(16383, Math.max(0, Math.round(8192*(1 + semitones/bendRange))));
            emit(Math.round(durationTicks * i/steps), 0xE0, bend & 0x7F, bend >> 7);
        }
        if (exceeded)
            diagnostics.push(`slide/deltaSlide bends ${exceeded.toFixed(1)} semitones, exceeds +/-${bendRange} semitone range, clamped`);
    }

    // the note itself
    emit(0, 0x90, note, velocity);
    emit(durationTicks, 0x80, note, 0);

    // report active parameters that have no MIDI equivalent
    const unmapped =
    [
        ['randomness',   sound.randomness,   v=>v,      'per-play pitch randomization, exported at nominal pitch'],
        ['shape',        sound.shape,        v=>v,      'wave shape has no MIDI equivalent, assign a patch in your DAW'],
        ['shapeCurve',   sound.shapeCurve-1, v=>v+1,    'wave shaping has no MIDI equivalent'],
        ['pitchJump',    sound.pitchJump,    v=>v,      'pitch jump is not mapped, only slide becomes pitch bend'],
        ['repeatTime',   sound.repeatTime,   v=>v,      'parameter retriggering has no MIDI equivalent'],
        ['tremolo',      sound.tremolo,      v=>v,      'tremolo is not mapped'],
        ['noise',        sound.noise,        v=>v,      'noise component has no MIDI equivalent'],
        ['bitCrush',     sound.bitCrush,     v=>v,      'bit crush has no MIDI equivalent'],
        ['delay',        sound.delay,        v=>v,      'echo/delay is not mapped'],
        ['modulation',   sound.modulation,   v=>v,      'modulation has no MIDI equivalent'],
        ['filter',       sound.filter,       v=>v,      'filter sweep has no MIDI equivalent'],
    ];
    for (const [name, value, display, reason] of unmapped)
        if (value)
            diagnostics.push(`${name} ${display(value)}: ${reason}`);

    return {events, diagnostics, note, velocity, durationTicks, durationSeconds, bpm};
}

// pack MIDI events into a standard MIDI file (SMF type 0), returns a Uint8Array
export function buildMidiFile(midiData)
{
    const {events, bpm} = midiData;
    const track = [];
    const pushVar = value => // variable length quantity
    {
        const bytes = [value & 0x7F];
        while (value >>= 7)
            bytes.unshift(0x80 | (value & 0x7F));
        track.push(...bytes);
    };

    // tempo meta event at tick 0
    const microsecondsPerQuarter = Math.round(6e7/bpm);
    pushVar(0);
    track.push(0xFF, 0x51, 0x03,
        microsecondsPerQuarter >> 16, microsecondsPerQuarter >> 8 & 0xFF, microsecondsPerQuarter & 0xFF);

    // events sorted by tick, delta encoded
    events.sort((a, b) => a.tick - b.tick);
    let lastTick = 0;
    for (const event of events)
    {
        pushVar(event.tick - lastTick);
        track.push(...event.data);
        lastTick = event.tick;
    }

    // end of track
    pushVar(0);
    track.push(0xFF, 0x2F, 0x00);

    // header: format 0, one track, division = midiPPQ
    const header = [
        0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, length 6
        0, 0, 0, 1,                          // format 0, 1 track
        midiPPQ >> 8, midiPPQ & 0xFF,
    ];
    const trackHeader = [
        0x4D, 0x54, 0x72, 0x6B,              // MTrk
        track.length >> 24, track.length >> 16 & 0xFF, track.length >> 8 & 0xFF, track.length & 0xFF,
    ];
    return new Uint8Array([...header, ...trackHeader, ...track]);
}

// render a sound to a midi blob url, returns {url, diagnostics, ...}
export function buildMidiURL(sound, options)
{
    const midiData = buildMidiData(sound, options);
    const file = buildMidiFile(midiData);
    const blob = new Blob([file], {type:'audio/midi'});
    return {url: URL.createObjectURL(blob), ...midiData};
}
