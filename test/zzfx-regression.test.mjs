// Regression guard: the refactored one-shot path and the new streaming path
// must emit bit-identical samples to the pre-change buildSamples() captured
// from git HEAD (the "before" library).
import {test, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'child_process';
import {
    loadZzfx, pinRandom, collectStream, firstMismatch,
    soundCases, chunkSizes
} from './zzfx-test-helper.mjs';

globalThis.AudioContext = class
{
    createBuffer(channelCount, length)
    {
        return {getChannelData: () => new Float32Array(length)};
    }
    createBufferSource() { return {connect(){ return this; }, start(){}}; }
    createGain() { return {connect(){}, gain: {}}; }
};
globalThis.StereoPannerNode = class { connect(node) { return node; } };

let originalZzfx = null;
try
{
    const originalSource = execFileSync(
        'git', ['show', 'HEAD:ZzFX.js'], {encoding: 'utf8'});
    const url = 'data:text/javascript;base64,' +
        Buffer.from(originalSource).toString('base64');
    originalZzfx = await import(url);
}
catch (error)
{
    // allow the suite to load in checkouts without git metadata
    test('git HEAD reference available', () => assert.fail(error.message));
}

const {ZZFX} = await loadZzfx();

if (originalZzfx)
describe('refactored output is bit-identical to the original library', () =>
{
    for (const soundCase of soundCases)
    {
        it(`new buildSamples matches original: ${soundCase.name}`, () =>
        {
            pinRandom();
            const original = originalZzfx.ZZFX.buildSamples(...soundCase.params);
            pinRandom();
            const current = ZZFX.buildSamples(...soundCase.params);
            const cmp = firstMismatch(original, current);
            assert.equal(cmp.mismatch, 0,
                `${cmp.mismatch} mismatching samples starting at ${cmp.first}`);
        });

        for (const chunkSize of chunkSizes)
        {
            it(`stream matches original: ${soundCase.name} @ ${chunkSize}`, () =>
            {
                pinRandom();
                const original = originalZzfx.ZZFX.buildSamples(...soundCase.params);
                pinRandom();
                const result = collectStream(
                    ZZFX.buildSamplesStream(chunkSize, ...soundCase.params));
                const cmp = firstMismatch(original, result.joined);
                assert.equal(cmp.mismatch, 0,
                    `${cmp.mismatch} mismatching samples starting at ${cmp.first}`);
            });
        }
    }

    it('matches the original with an advancing random sequence too', () =>
    {
        let state = 987654321;
        const lcg = () =>
        {
            state = (state * 1103515245 + 12345) & 0x7fffffff;
            return state / 0x7fffffff;
        };
        const params = [0.7, .1, 350, .1, .2, .3, 3, 1.3, .2, .1, 70,
            .08, .1, .2, .3, 1, .25, .9, .1, .25];
        state = 987654321;
        Math.random = lcg;
        const original = originalZzfx.ZZFX.buildSamples(...params);
        state = 987654321;
        Math.random = lcg;
        const current = ZZFX.buildSamples(...params);
        assert.equal(firstMismatch(original, current).mismatch, 0);
        state = 987654321;
        Math.random = lcg;
        const streamed = collectStream(
            ZZFX.buildSamplesStream(2048, ...params));
        assert.equal(firstMismatch(original, streamed.joined).mismatch, 0);
    });
});
