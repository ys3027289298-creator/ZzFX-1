// wav.js by Frank Force - https://github.com/KilledByAPixel/ZzFX

const WAV_HEADER_SIZE = 23; // size of wav header in 16-bit words (46 bytes)

// write a 46 byte RIFF/WAVE header into an Int16Array
// header layout matches the original buildWavURL byte for byte
// wave header adapted from https://gist.github.com/asanoboy/3979747
function writeWavHeader(buffer, sampleRate, channelCount, bitDepth, dataSize)
{
    const headerSize = WAV_HEADER_SIZE;

    // RIFF (ascii)
    buffer[ 0] = 0x4952; // RF
    buffer[ 1] = 0x4646; // FF

    // RIFF size
    const riffSize = dataSize + headerSize*2 - 8;
    buffer[ 2] = riffSize & 0x0000ffff;
    buffer[ 3] = (riffSize & 0xffff0000) >> 16;

    // WAVE (ascii)
    buffer[ 4] = 0x4157; // WA
    buffer[ 5] = 0x4556; // VE

    // fmt (ascii)
    buffer[ 6] = 0x6d66; // fm
    buffer[ 7] = 0x2074; // t

    // format chunk size: 18
    buffer[ 8] = 0x0012;
    buffer[ 9] = 0x0000;

    // format tag: 1 (PCM format)
    buffer[10] = 0x0001;

    // channel count
    buffer[11] = channelCount;

    // samples per second
    buffer[12] = sampleRate & 0x0000ffff;
    buffer[13] = (sampleRate & 0xffff0000) >> 16;

    // bytes per second
    const bytesPerSecond = channelCount*sampleRate*bitDepth/8;
    buffer[14] = bytesPerSecond & 0x0000ffff;
    buffer[15] = (bytesPerSecond & 0xffff0000) >> 16;

    // sample size
    // 16-bit keeps the legacy block align of 4 so streamed output stays
    // byte identical to buildWavURL, 24-bit uses the correct 3*channelCount
    buffer[16] = bitDepth == 16 ? 0x0004 : 3*channelCount;
    buffer[17] = bitDepth; // bits per sample
    buffer[18] = 0x0000; // padding

    // DATA (ascii)
    buffer[19] = 0x6164; // DA
    buffer[20] = 0x6174; // TA

    // data size
    buffer[21] = dataSize & 0x0000ffff;
    buffer[22] = (dataSize & 0xffff0000) >> 16;
}

export function buildWavBytes(sampleChannels, sampleRate = 44100)
{
    const channelCount = sampleChannels.length;
    const sampleCount = sampleChannels[0].length;
    const length = channelCount * sampleCount;
    const headerSize = WAV_HEADER_SIZE;
    const buffer = new Int16Array(length + headerSize);
    console.assert(channelCount && sampleCount, 'No channels or samples found!');

    // wave header
    writeWavHeader(buffer, sampleRate, channelCount, 16, 2*length);

    // copy samples to buffer
    for (let j = channelCount; j--;)
    for (let i = sampleCount; i--;)
    {
        const s = sampleChannels[j][i];
        buffer[i*channelCount + j + headerSize] = s<1 ? (s * (1<<15) | 0) : (1<<15) - 1;
    }

    // return the wav bytes
    return new Uint8Array(buffer.buffer);
}

export function buildWavURL(sampleChannels, sampleRate = 44100)
{
    // return the url
    const blob = new Blob([buildWavBytes(sampleChannels, sampleRate)], {type:'audio/wav'});
    return URL.createObjectURL(blob);
}

// frames per internal conversion chunk, bounds the streaming writer's
// memory to 16384 frames * channelCount * (bitDepth/8) bytes plus one 46
// byte header, independent of the total audio length
const WAV_STREAM_CHUNK_FRAMES = 1 << 14;

/**
 * Create a streaming WAV writer that renders and writes chunk by chunk
 * instead of holding the whole file in memory. Requires node:fs (Node,
 * Bun, Deno); the one-shot buildWavURL/buildWavBytes above still work
 * everywhere. Memory use is bounded by one conversion chunk
 * (16384 frames * channelCount * bitDepth/8 bytes) plus a 46 byte header,
 * regardless of total duration. The header sizes are backfilled when
 * end() is called. If any write fails or abort() is called, the partial
 * file is closed and deleted.
 *
 * const writer = await createWavWriter(path, {sampleRate, channelCount, bitDepth});
 * await writer.write([leftChunk, rightChunk]); // float samples, repeat as needed
 * const info = await writer.end(); // backfills header, closes file
 *
 * 16-bit output is byte identical to buildWavBytes for the same input.
 * @param {string} filePath - destination file path
 * @param {object} options
 * @param {number} options.sampleRate - integer 1..4294967295, default 44100
 * @param {number} options.channelCount - integer 1..65535, default 2
 * @param {number} options.bitDepth - 16 or 24, default 16
 */
export async function createWavWriter(filePath, {sampleRate = 44100, channelCount = 2, bitDepth = 16} = {})
{
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 0xffffffff)
        throw new RangeError(`invalid sampleRate ${sampleRate}, expected an integer between 1 and 4294967295`);
    if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 0xffff)
        throw new RangeError(`invalid channelCount ${channelCount}, expected an integer between 1 and 65535`);
    if (bitDepth !== 16 && bitDepth !== 24)
        throw new RangeError(`invalid bitDepth ${bitDepth}, expected 16 or 24`);

    const {promises: fs} = await import('node:fs');

    const bytesPerSample = bitDepth/8;
    const frameBytes = channelCount * bytesPerSample;
    const chunkFrames = WAV_STREAM_CHUNK_FRAMES;
    const chunkBuffer = Buffer.allocUnsafe(chunkFrames * frameBytes);
    const header = new Int16Array(WAV_HEADER_SIZE);

    let fileHandle, dataSize = 0, ended = false, failure;

    const failWith = async (error) =>
    {
        // close and delete the half written file, then rethrow
        failure = failure || error;
        try { if (fileHandle) await fileHandle.close(); } catch {}
        try { await fs.unlink(filePath); } catch {}
        throw failure;
    };

    try
    {
        fileHandle = await fs.open(filePath, 'w');
        // write a placeholder header, sizes are backfilled by end()
        writeWavHeader(header, sampleRate, channelCount, bitDepth, 0);
        const headerBytes = Buffer.from(header.buffer, 0, WAV_HEADER_SIZE*2);
        await fileHandle.write(headerBytes, 0, headerBytes.length);
    }
    catch (error)
    {
        await failWith(error);
    }

    const writer = {
        path: filePath, sampleRate, channelCount, bitDepth,
        get dataBytes() { return dataSize; },

        // write one chunk of samples, an array of channelCount sample
        // arrays of equal length, samples are floats clamped to [-1, 1)
        async write(sampleChannels)
        {
            if (failure) throw failure;
            if (ended)   throw new Error('cannot write() after end()');
            if (!Array.isArray(sampleChannels) || sampleChannels.length != channelCount)
                return failWith(new TypeError(`expected ${channelCount} channel arrays, got ${sampleChannels && sampleChannels.length}`));
            const frameCount = sampleChannels[0].length;
            for (let j = channelCount; j--;)
                if (!sampleChannels[j] || sampleChannels[j].length != frameCount)
                    return failWith(new TypeError(`channel ${j} has length ${sampleChannels[j] && sampleChannels[j].length}, expected ${frameCount}`));

            try
            {
                for (let start = 0; start < frameCount; start += chunkFrames)
                {
                    const frames = Math.min(chunkFrames, frameCount - start);
                    // interleave and quantize into the reusable chunk buffer
                    for (let i = 0; i < frames; ++i)
                    for (let j = 0; j < channelCount; ++j)
                    {
                        const s = sampleChannels[j][start + i];
                        const offset = (i*channelCount + j) * bytesPerSample;
                        if (bitDepth == 16)
                        {
                            // same quantization as buildWavBytes
                            const v = (s<1 ? (s * (1<<15) | 0) : (1<<15) - 1) & 0xffff;
                            chunkBuffer[offset  ] = v;
                            chunkBuffer[offset+1] = v >> 8;
                        }
                        else
                        {
                            const v = (s<1 ? (s * (1<<23) | 0) : (1<<23) - 1) & 0xffffff;
                            chunkBuffer[offset  ] = v;
                            chunkBuffer[offset+1] = v >> 8;
                            chunkBuffer[offset+2] = v >> 16;
                        }
                    }
                    // write fully, handling short writes
                    const bytes = frames * frameBytes;
                    for (let written = 0; written < bytes;)
                        written += (await fileHandle.write(chunkBuffer, 0, bytes - written)).bytesWritten;
                    dataSize += bytes;
                }
            }
            catch (error)
            {
                await failWith(error);
            }
        },

        // backfill the header with final sizes and close the file
        async end()
        {
            if (failure) throw failure;
            if (ended)   throw new Error('end() was already called');
            ended = true;
            try
            {
                writeWavHeader(header, sampleRate, channelCount, bitDepth, dataSize);
                const headerBytes = Buffer.from(header.buffer, 0, WAV_HEADER_SIZE*2);
                await fileHandle.write(headerBytes, 0, headerBytes.length, 0);
                await fileHandle.close();
            }
            catch (error)
            {
                await failWith(error);
            }
            return {
                path: filePath,
                sampleFrames: dataSize / frameBytes,
                dataBytes: dataSize,
                fileBytes: dataSize + WAV_HEADER_SIZE*2,
            };
        },

        // abort the write, closes and deletes the partial file
        async abort()
        {
            if (failure) return;
            ended = true;
            failure = new Error('wav writer aborted');
            try { if (fileHandle) await fileHandle.close(); } catch {}
            try { await fs.unlink(filePath); } catch {}
        },
    };
    return writer;
}
