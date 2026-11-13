// Minimal browser API stubs so the repo's ES modules can be exercised under Node.
'use strict';

class FakeBufferSource
{
    constructor()
    {
        this.buffer = null;
        this.playbackRate = {value: 1};
        this.loop = false;
        this.gainNode = null;
    }
    connect(node) { return node; }
    start() {}
    stop() {}
}

class FakeGainNode
{
    constructor() { this.gain = {value: 1}; }
    connect(node) { return node; }
}

class FakePannerNode
{
    connect(node) { return node; }
}

class FakeAudioBuffer
{
    constructor(channelCount, length, sampleRate)
    {
        this.numberOfChannels = channelCount;
        this.length = length;
        this.sampleRate = sampleRate;
        this._channels = Array.from({length: channelCount}, () => new Float32Array(length));
    }
    getChannelData(i) { return this._channels[i]; }
}

class FakeAudioContext
{
    createBuffer(channelCount, length, sampleRate)
    {
        return new FakeAudioBuffer(channelCount, length, sampleRate);
    }
    createBufferSource() { return new FakeBufferSource(); }
    createGain() { return new FakeGainNode(); }
}

globalThis.AudioContext = FakeAudioContext;
globalThis.StereoPannerNode = class { constructor() {} connect(node) { return node; } };
globalThis.Blob = class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = () => 'blob:fake-url';
globalThis.URL.revokeObjectURL = () => {};
