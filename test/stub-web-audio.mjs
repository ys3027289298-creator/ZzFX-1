// Minimal stubs so ZzFX.js (which constructs an AudioContext at import time)
// can be imported under Node. Audio rendering itself is never used by the
// tests; only buildSamples() (pure Float32Array math) is exercised.

class GainNode
{
    constructor() { this.gain = {value:0}; this.connect = () => this; }
}

class AudioBufferSourceNode
{
    constructor(ctx)
    {
        this.context = ctx;
        this.buffer = null;
        this.playbackRate = {value:1};
        this.loop = false;
        this.gainNode = null;
        this.connect = () => this;
        this.start = () => {};
    }
}

export class AudioContext
{
    constructor()
    {
        this.destination = {};
        this.sampleRate = 44100;
    }
    createBuffer(channelCount, length, sampleRate)
    {
        const channels = Array.from({length:channelCount}, () => new Float32Array(length));
        return {
            length,
            sampleRate,
            numberOfChannels: channelCount,
            getChannelData(i) { return channels[i]; }
        };
    }
    createBufferSource() { return new AudioBufferSourceNode(this); }
    createGain() { return new GainNode(); }
}

export class StereoPannerNode
{
    constructor()
    {
        this.connect = () => this;
    }
}

globalThis.AudioContext = AudioContext;
globalThis.StereoPannerNode = StereoPannerNode;
