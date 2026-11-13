// wav.js by Frank Force - https://github.com/KilledByAPixel/ZzFX

// build a wav file as a byte array from sample channels
// - sampleChannels: array of sample arrays, one per channel, values in [-1, 1]
// - sampleRate: samples per second, must be a positive integer
// - options.bitDepth: bits per sample, must be 1, 8, or 16 (default 16)
// - options.signed: signed or unsigned pcm (default signed for 16-bit,
//   unsigned for 8-bit, ignored for 1-bit)
// - options.threshold: 1-bit decision threshold in [-1, 1] (default 0),
//   a sample becomes a 1 bit when sample >= threshold
// with default options the output is byte identical to previous releases
export function buildWavBytes(sampleChannels, sampleRate = 44100, options = {})
{
    const channelCount = sampleChannels.length;
    const sampleCount = channelCount ? sampleChannels[0].length : 0;
    const length = channelCount * sampleCount;
    console.assert(channelCount && sampleCount, 'No channels or samples found!');

    // parse and validate options
    const { bitDepth = 16, signed = bitDepth > 8, threshold = 0 } = options;
    if (![1, 8, 16].includes(bitDepth))
        throw new RangeError(`bitDepth must be 1, 8, or 16, got ${bitDepth}`);
    if (!(sampleRate > 0) || sampleRate % 1)
        throw new RangeError(`sampleRate must be a positive integer, got ${sampleRate}`);
    if (bitDepth == 1 && !(threshold >= -1 && threshold <= 1))
        throw new RangeError(`threshold must be between -1 and 1, got ${threshold}`);

    // 1-bit packs 8 samples per byte, padding the final byte with 0 bits
    const headerSize = 46;
    const dataSize = bitDepth == 1 ? Math.ceil(length / 8) : length * bitDepth / 8;
    const riffSize = dataSize + headerSize - 8;

    // 16-bit keeps the hardcoded block align and byte rate of previous
    // releases so default output stays byte identical, other bit depths
    // get spec correct values
    const blockAlign = bitDepth == 16 ? 4 : Math.ceil(channelCount * bitDepth / 8);
    const byteRate = bitDepth == 16 ? 2 * channelCount * sampleRate :
        Math.ceil(sampleRate * channelCount * bitDepth / 8);

    const buffer = new Uint8Array(headerSize + dataSize);
    const view = new DataView(buffer.buffer);
    const writeText = (offset, text) =>
    {
        for (let i = 0; i < text.length; ++i)
            buffer[offset + i] = text.charCodeAt(i);
    };

    {
        // wave header adapted from https://gist.github.com/asanoboy/3979747

        // RIFF (ascii)
        writeText(0, 'RIFF');

        // RIFF size
        view.setUint32(4, riffSize, true);

        // WAVE (ascii)
        writeText(8, 'WAVE');

        // fmt (ascii)
        writeText(12, 'fmt ');

        // format chunk size: 18
        view.setUint32(16, 18, true);

        // format tag: 1 (PCM format)
        view.setUint16(20, 1, true);

        // channel count
        view.setUint16(22, channelCount, true);

        // samples per second
        view.setUint32(24, sampleRate, true);

        // bytes per second
        view.setUint32(28, byteRate, true);

        // block align and bits per sample
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        view.setUint16(36, 0, true); // padding

        // DATA (ascii)
        writeText(38, 'data');

        // data size
        view.setUint32(42, dataSize, true);
    }

    if (bitDepth == 16)
    {
        // copy samples to buffer, same conversion as previous releases
        for (let j = channelCount; j--;)
        for (let i = sampleCount; i--;)
        {
            const s = sampleChannels[j][i];
            const v = s<1 ? (s * (1<<15) | 0) : (1<<15) - 1;
            const offset = headerSize + 2*(i*channelCount + j);
            signed ? view.setInt16(offset, v, true)
                   : view.setUint16(offset, v + (1<<15), true);
        }
    }
    else if (bitDepth == 8)
    {
        // 8-bit clamps out of range samples instead of wrapping
        for (let j = channelCount; j--;)
        for (let i = sampleCount; i--;)
        {
            const s = sampleChannels[j][i];
            const v = s<1 ? Math.max(s * (1<<7) | 0, -(1<<7)) : (1<<7) - 1;
            buffer[headerSize + i*channelCount + j] = signed ? v & 0xff : v + (1<<7);
        }
    }
    else // bitDepth == 1
    {
        // 1-bit pcm, samples are decided against the threshold and packed
        // msb first, 8 samples per byte, interleaved per sample frame
        let byte = 0, bitCount = 0, offset = headerSize;
        for (let i = 0; i < sampleCount; ++i)
        for (let j = 0; j < channelCount; ++j)
        {
            byte = byte<<1 | (sampleChannels[j][i] >= threshold ? 1 : 0);
            if (++bitCount == 8)
            {
                buffer[offset++] = byte;
                byte = bitCount = 0;
            }
        }
        if (bitCount)
            buffer[offset] = byte << (8 - bitCount);
    }

    return buffer;
}

// build a wav blob url from sample channels, see buildWavBytes for options
export function buildWavURL(sampleChannels, sampleRate = 44100, options)
{
    // return the url
    const blob = new Blob([buildWavBytes(sampleChannels, sampleRate, options)], {type:'audio/wav'});
    return URL.createObjectURL(blob);
}
