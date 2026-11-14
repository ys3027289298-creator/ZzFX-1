// Test helpers: load ZzFX.js under Node (which has no AudioContext) and
// provide deterministic Math.random plus stream-collection utilities.

// ZZFX.audioContext is constructed at module load; browsers provide the
// constructor, the Node test process does not, so stub it before importing.
globalThis.AudioContext = class
{
    createBuffer(channelCount, length)
    {
        const channels = Array.from({length: channelCount}, () => new Float32Array(length));
        return {getChannelData: i => channels[i]};
    }
    createBufferSource() { return {connect(){ return this; }, start(){}}; }
    createGain() { return {connect(){}, gain: {}}; }
};
globalThis.StereoPannerNode = class
{
    connect(node) { return node; }
};

import {readFileSync} from 'fs';
import {resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadZzfx(modulePath = '../ZzFX.js')
{
    // package.json has no "type": "module", so Node parses .js as CommonJS
    // and rejects the ESM export syntax. Import through a data URL instead;
    // no build scripts or package metadata need to change.
    const code = readFileSync(resolve(here, modulePath), 'utf8');
    const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
    return import(url);
}

// pin Math.random so one-shot and streamed runs consume the same values
export function pinRandom(value = 0.424242)
{
    Math.random = () => value;
}

// drain a chunked stream into one Float32Array, exercising the iterator
export function collectStream(stream)
{
    const chunks = [];
    let total = 0;
    for (const chunk of stream)
    {
        chunks.push(chunk);
        total += chunk.length;
    }
    const joined = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks)
    {
        joined.set(chunk, offset);
        offset += chunk.length;
    }
    return {joined, chunkCount: chunks.length, chunks};
}

// bit-exact comparison of two Float32Arrays (Object.is also matches NaN)
export function firstMismatch(a, b)
{
    if (a.length != b.length)
        return {mismatch: -1, first: -1};
    let count = 0;
    let first = -1;
    for (let i = 0; i < a.length; ++i)
    {
        if (!Object.is(a[i], b[i]))
        {
            if (first < 0)
                first = i;
            ++count;
        }
    }
    return {mismatch: count, first};
}

// shared sound parameter sets exercising every stateful subsystem
export const soundCases = [
    {name: 'default-sine', params: []},
    {name: 'game-over', params: [1,.05,925,.04,.3,.6,1,.3,0,6.27,-184,.09,.17]},
    {name: 'piano', params: [1.5,0,270,.2,.1,.2,1,1.5,0,0,0,0,0,0,0,0,.1,.01]},
    {name: 'drum', params: [1,0,129,.01,0,.15,0,1,0,0,0,0,0,0,0,0,5]},
    {name: 'repeat-loop', params: [1,0,440,.1,.2,.2,2,.8,0.3,0.1,60,.05,.2,0.2,0.2,2,.5,1,.1,0.2]},
    {name: 'delay-echo', params: [1,0,330,.05,.1,.3,3,1.2,0,0,0,0,0,0,0,0,.35,1,.1,0]},
    {name: 'biquad-filter', params: [1,0,220,.1,.1,.2,1,1,0,0,0,0,0,0,0,0,0,1,0,.5]},
    {name: 'all-features', params: [1.2,.03,523,.08,.15,.25,4,.7,.4,.2,80,.06,.12,.35,.25,3,.3,.8,.18,.4]}
];

export const chunkSizes = [1024, 16384, 262144];
