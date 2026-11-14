import {test, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    loadZzfx, pinRandom, collectStream, firstMismatch,
    soundCases, chunkSizes
} from './zzfx-test-helper.mjs';

const {ZZFX, ZZFXSound} = await loadZzfx();

// helper: bit-exact one-shot vs streamed comparison for one sound
function compare(params, chunkSize)
{
    pinRandom();
    const reference = ZZFX.buildSamples(...params);
    pinRandom();
    const stream = ZZFX.buildSamplesStream(chunkSize, ...params);
    assert.equal(stream.length, reference.length);
    const {joined, chunkCount, chunks} = collectStream(stream);
    assert.equal(stream.position, reference.length);
    const {mismatch, first} = firstMismatch(reference, joined);
    return {reference, joined, mismatch, first, chunkCount, chunks, stream};
}

describe('streamed output is sample-exact to the one-shot path', () =>
{
    for (const chunkSize of chunkSizes)
    for (const soundCase of soundCases)
    {
        it(`${soundCase.name} @ chunkSize=${chunkSize}`, () =>
        {
            const {reference, mismatch, first} = compare(soundCase.params, chunkSize);
            assert.equal(mismatch, 0,
                `${mismatch} mismatching samples, first at index ${first} of ${reference.length}`);
        });
    }

    it('every chunk is a Float32Array no larger than chunkSize', () =>
    {
        const chunkSize = 1024;
        pinRandom();
        const stream = ZZFX.buildSamplesStream(chunkSize, ...soundCases[4].params);
        const {chunks, joined} = collectStream(stream);
        for (const chunk of chunks.slice(0, -1))
        {
            assert.ok(chunk instanceof Float32Array);
            assert.equal(chunk.length, chunkSize);
        }
        assert.ok(chunks.at(-1).length <= chunkSize);
        assert.equal(joined.length, stream.length);
    });

    it('chunkSize=1 emits one sample per chunk and stays bit-exact', () =>
    {
        const {mismatch, chunkCount, reference} = compare(soundCases[0].params, 1);
        assert.equal(mismatch, 0);
        assert.equal(chunkCount, reference.length);
    });

    it('chunkSize larger than the sound yields one partial chunk', () =>
    {
        const {mismatch, chunkCount, reference} = compare(soundCases[0].params, 99999999);
        assert.equal(mismatch, 0);
        assert.equal(chunkCount, 1);
    });

    it('next() keeps returning done after the stream is exhausted', () =>
    {
        pinRandom();
        const stream = ZZFX.buildSamplesStream(64, ...soundCases[0].params);
        collectStream(stream);
        const r1 = stream.next();
        const r2 = stream.next();
        assert.equal(r1.done, true);
        assert.equal(r2.done, true);
        assert.equal(r1.value, undefined);
    });
});

describe('state survives arbitrary chunk boundaries', () =>
{
    // repeatTime is the synth loop point: phase/slide/jump reset at each
    // repeat. Pick block sizes that deliberately straddle the loop boundary.
    it('repeatTime loop wraps correctly across non-aligned block boundaries', () =>
    {
        const params = [1, 0, 440, .05, .1, .1, 2, 1, 0, 0, 50, .02, .03,
            0, 0, 0, 0, 1, 0, 0];
        pinRandom();
        const reference = ZZFX.buildSamples(...params);
        const repeatSamples = .03 * ZZFX.sampleRate | 0;
        for (const offset of [-2, -1, 1, 2])
        {
            const chunkSize = repeatSamples + offset;
            pinRandom();
            const result = collectStream(ZZFX.buildSamplesStream(chunkSize, ...params));
            const cmp = firstMismatch(reference, result.joined);
            assert.equal(cmp.mismatch, 0,
                `loop boundary straddle chunkSize=${chunkSize}: ` +
                `${cmp.mismatch} mismatches starting at ${cmp.first}`);
        }
    });

    it('delay history ring buffer stays coherent across blocks', () =>
    {
        const params = soundCases[5].params; // delay-echo sound
        for (const chunkSize of [1, 33, 1024])
        {
            pinRandom();
            const reference = ZZFX.buildSamples(...params);
            pinRandom();
            const result = collectStream(ZZFX.buildSamplesStream(chunkSize, ...params));
            const cmp = firstMismatch(reference, result.joined);
            assert.equal(cmp.mismatch, 0,
                `delay path chunkSize=${chunkSize}: ${cmp.mismatch} mismatches`);
        }
    });

    it('fractional delay smaller than one sample still matches', () =>
    {
        // 0.00001s * 44100 = 0.441 samples: exercises the ceil() ring sizing
        const params = [1, 0, 220, .05, .05, .1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, .00001];
        pinRandom();
        const reference = ZZFX.buildSamples(...params);
        pinRandom();
        const result = collectStream(ZZFX.buildSamplesStream(7, ...params));
        const cmp = firstMismatch(reference, result.joined);
        assert.equal(cmp.mismatch, 0);
    });

    it('two independent streams do not share mutable state', () =>
    {
        pinRandom();
        const a = ZZFX.buildSamplesStream(128, ...soundCases[4].params);
        pinRandom();
        const b = ZZFX.buildSamplesStream(128, ...soundCases[4].params);
        const aFirst = a.next().value;
        const bFirst = b.next().value;
        const cmp = firstMismatch(aFirst, bFirst);
        assert.equal(cmp.mismatch, 0);
        a.next();
        const bSecond = b.next().value;
        assert.equal(bSecond.length, 128);
    });
});

describe('chunk size validation', () =>
{
    const expectations = [
        [0, RangeError], [-1, RangeError], [-1000, RangeError],
        [1.5, RangeError], [0.9, RangeError], [Number.MIN_VALUE, RangeError],
        [NaN, TypeError], [Infinity, TypeError], [-Infinity, TypeError],
        ['16', TypeError], [null, TypeError], [undefined, TypeError], [{}, TypeError]
    ];
    for (const [bad, ErrorType] of expectations)
    {
        it(`rejects ${String(bad)} with ${ErrorType.name}`, () =>
        {
            assert.throws(() => ZZFX.buildSamplesStream(bad, 1, 0, 220),
                err => err instanceof ErrorType && err.message.length > 0);
        });
    }

    it('accepts boundary value chunkSize=1', () =>
    {
        pinRandom();
        const stream = ZZFX.buildSamplesStream(1, ...soundCases[0].params);
        assert.equal(stream.next().value.length, 1);
    });
});

describe('public one-shot behavior is unchanged', () =>
{
    it('buildSamples still returns a Float32Array of the documented length', () =>
    {
        pinRandom();
        // volume=1, randomness=0, frequency=220, attack=0 (minAttack 9),
        // sustain=.1s plus the default .1s release; decay and delay are 0
        const samples = ZZFX.buildSamples(1, 0, 220, 0, .1, .1);
        assert.ok(samples instanceof Float32Array);
        const sr = ZZFX.sampleRate;
        const expected = (9 + .1 * sr + .1 * sr) | 0;
        assert.equal(samples.length, expected);
    });

    it('ZZFXSound caching path still works and matches direct build', () =>
    {
        pinRandom();
        const params = [1, 0, 300, .1, .1, .1];
        const direct = ZZFX.buildSamples(...params);
        pinRandom();
        const sound = new ZZFXSound([1, 0, 300, .1, .1, .1]);
        const cmp = firstMismatch(direct, sound.samples);
        assert.equal(cmp.mismatch, 0);
    });
});
