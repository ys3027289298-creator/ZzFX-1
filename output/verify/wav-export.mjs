// Validate the repo's wav.js export path at both sample rates and write real
// .wav artifacts into output/wav/ using a small Node-side PCM writer that
// mirrors wav.js's header layout.
'use strict';

import './polyfills.mjs';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {ZZFX} from './ZzFX-link.js';
import {buildWavURL} from './wav-link.js';
import {sounds} from './sounds.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'wav');
const RATES = [44100, 48000];

function renderAt(params, rate)
{
    const filled = params.slice();
    while (filled.length < 21) filled.push(undefined);
    return ZZFX.buildSamples(...filled, rate);
}

// Node-side PCM16 WAV writer (same 44-byte header semantics as wav.js)
function writeWavFile(path, samples, sampleRate)
{
    const headerSize = 44;
    const dataSize = samples.length * 2;
    const buffer = Buffer.alloc(headerSize + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);                 // PCM
    buffer.writeUInt16LE(1, 22);                 // mono
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);    // bytes per second
    buffer.writeUInt16LE(2, 32);                 // block align
    buffer.writeUInt16LE(16, 34);                // bits per sample
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++)
    {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buffer.writeInt16LE(s < 1 ? (s * 32768) | 0 : 32767, 44 + i * 2);
    }
    writeFileSync(path, buffer);
}

let failures = 0;
for (const rate of RATES)
{
    for (const {name, params} of sounds)
    {
        const samples = renderAt(params, rate);

        // exercise the repo's own exporter (returns a blob URL under the stub)
        const url = buildWavURL([samples], rate);
        if (!url.startsWith('blob:')) failures++;

        // persist a real file for manual/audible inspection
        writeWavFile(join(outDir, `${name}-${rate}.wav`), samples, rate);
    }
}

console.log(`wrote ${RATES.length * sounds.length} wav files to ${outDir}`);
if (failures) { console.log('wav.js export failed'); process.exitCode = 1; }
else console.log('wav.js accepts both 44100 and 48000 sample rates');
