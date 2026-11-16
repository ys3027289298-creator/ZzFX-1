// Renders artifacts/effects-report.md from artifacts/verify-results.json.

import {writeFileSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const r = JSON.parse(readFileSync(
    fileURLToPath(new URL('../artifacts/verify-results.json', import.meta.url)), 'utf8'));
const f = n => Number(n).toFixed(6);
const bool = v => `**${v ? 'true' : 'false'}**`;

let md = '';
md += '# ZzFX Spatial Effects (Reverb + Delay) - Verification Report\n\n';
md += `Generated: ${r.generatedAt}\n`;
md += `Sample rate: ${r.sampleRate} Hz\n`;
md += `Baseline source: ${r.baselineSource}\n`;
md += `Input params (randomness=0): \`${JSON.stringify(r.comparison.input)}\`\n`;
md += 'Reproduce everything with: `node test/make-baseline.mjs && node test/run-verify.mjs && node test/render-report.mjs`\n';
md += 'Reproduce one failure case with: `node test/run-verify.mjs --case=e2-negative`\n\n';

md += '## 1. Before/after comparison on identical input\n\n';
md += '| Metric | Baseline (pristine ZzFX.js) | New build, effects off | New build, effects on |\n';
md += '| --- | --- | --- | --- |\n';
const c = r.comparison;
md += `| Samples | ${c.baseline.samples} | ${c.effectsOff.samples} | ${c.effectsOn.samples} |\n`;
md += `| Peak | ${c.baseline.peak} | ${c.effectsOff.peak} | ${c.effectsOn.peak} |\n`;
md += `| SHA-256 | \`${c.baseline.sha256}\` | \`${c.effectsOff.sha256}\` | \`${c.effectsOn.sha256}\` |\n`;
md += `| Differing samples vs baseline | - | ${c.differingSamples} | (effects active, differs by design) |\n\n`;
md += `Effects-on options: \`${JSON.stringify(c.effectsOn.options)}\`\n\n`;

md += '## 2. Bit-exact old-behavior verification\n\n';
md += `- Input parameter sets: ${r.exactness.inputCount}\n`;
md += `- Disabled-effects shapes per input: ${r.exactness.shapeCount} (\`omitted\`, \`null\`, \`empty object\`, \`zero delayTime\`, \`zero delayMix\`, \`all zero\`, \`zero reverbMix\`)\n`;
md += `- Bit-exact checks: ${r.exactness.checks.filter(x => x.bitExact).length}/${r.exactness.totalChecks}, all passed: ${bool(r.exactness.pass)}\n`;
md += `- Inactive options return the exact same Float32Array reference: ${bool(r.exactness.checks.every(x => x.sameReference))}\n`;
md += '- Comparison is SHA-256 over raw Float32 bytes against `test/fixtures/baseline.json` (generated from the pristine `ZzFX.js` at git HEAD). The engine file itself is never modified.\n\n';

md += '## 3. Failure paths (reproducible)\n\n';
md += 'Reproduce a single case:\n```js\n';
md += "import {applyEffects, ZzFXEffectsError} from './ZzFXEffects.js';\n";
md += "try { applyEffects(buffer, {delayTime: -0.1}); }\n";
md += 'catch (e) { console.log(e.code, e.codeNumber, e.message); } // ZZFX_E2 2 ...\n```\n';
md += 'CLI: `node test/run-verify.mjs --case <id>`\n\n';
md += '| Case | Expected code | Observed | Pass |\n| --- | --- | --- | --- |\n';
for (const x of r.failurePaths.checks)
    md += `| ${x.id} | ${x.expected} | ${x.observed} | ${x.pass} |\n`;
md += '\nRanges: E2 delayTime [0,1] s; E3 delayFeedback [0,0.95) (0.95 rejected); E4 delayMix [0,1]; E5 reverbTail [0,2] s and >0 when reverbMix>0; E6 reverbMix [0,1]; E7 unknown option key; E8 non-Float32Array/empty buffer; E9 feedback or mix supplied while delayTime is omitted (an explicit delayTime of 0 simply disables the delay). E1 covers non-plain-object options; E10 covers non-finite input samples.\n\n';

md += '## 4. Three parameter sets - tail duration and peak data\n\n';
md += `Tail threshold: |sample| > ${r.tailSets.threshold} (-80 dB). Allocated tail is the hard buffer extension; measured tail is the post-dry span above threshold. Impulse tap peaks come from a unit impulse through the delay, so tap n is \`mix * feedback^(n-1)\` for n >= 1; natural echo counts use the same -80 dB floor on that geometric amplitude, and the rendered echo list may end earlier when the 3 s hard cap truncates the tail.\n\n`;
md += '| Set | delayTime / feedback / mix | reverbTail / reverbMix | Echoes (natural / cap) | Capped | Allocated tail (ms) | Measured tail (ms) | Overall peak | Analytic peak bound | Tail peak | Finite | Max tap ratio | Decays |\n';
md += '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n';
for (const x of r.tailSets.checks)
{
    const o = x.options;
    md += `| ${x.id}: ${x.label} | ${o.delayTime} / ${o.delayFeedback} / ${o.delayMix} | ${o.reverbTail} / ${o.reverbMix} | ${x.naturalEchoes} (${x.capEchoes}) | ${x.capped} | ${f(x.allocatedTailMs)} | ${f(x.measuredTailMs)} | ${x.overallPeak} | ${f(x.analyticPeakBound * x.dryPeak)} | ${x.tailPeak} | ${x.finite} | ${x.maxTapRatio} | ${x.decays} |\n`;
}
md += '\n';
for (const x of r.tailSets.checks)
    md += `- **${x.id}: ${x.label}** impulse tap peaks: ${x.impulseTapPeaks.map(v => f(v)).join(', ')}\n`;
md += '\nEvery consecutive-tap ratio equals the configured feedback within float32 tolerance (wet series is the geometric sequence `mix*feedback^(n-1)`), bounded by construction because feedback < 0.95. The 3000 ms hard cap truncates long tails instead of letting them run. In addition to the measured peaks, `getPeakBound()` derives a hard per-sample analytic bound from the chain topology (delay gain `1+mix`; reverb gain `1 + reverbMix/(1-g)` with every comb gain `|g| < 1`) and every rendered peak is asserted against it (`withinBound`). Divergence proof (all taps non-increasing, all buffers finite, all peaks within bound) for sets A/B/C: '
    + `${bool(r.tailSets.pass)}\n\n`;

md += '### Boundary stress (feedback 0.94, delay 1 s, mix 0.5)\n\n';
const s = r.stress;
md += `- All samples finite: ${bool(s.finite)}\n`;
md += `- Overall peak: ${s.overallPeak} vs analytic bound ${f(s.analyticPeakBound)} (within bound: ${bool(s.withinBound)}; first echo peak: ${s.firstEchoPeak})\n`;
md += `- Allocated tail: ${f(s.allocatedTailMs)} ms (within cap: ${bool(s.withinCap)})\n`;
md += `- Echo count: ${s.echoCount}; monotonic decay: ${bool(s.monotonicDecay)}\n`;
md += `- Impulse tap peaks: ${s.impulseTapPeaks.map(v => f(v)).join(', ')}\n\n`;

md += '## 5. Reverb and serial delay + reverb\n\n';
md += '| Case | Allocated tail (ms) | Measured tail (ms) | Peak | Analytic peak bound | Finite |\n| --- | --- | --- | --- | --- | --- |\n';
for (const x of r.reverb.checks)
    md += `| ${x.name} | ${f(x.allocatedTailMs)} | ${f(x.measuredTailMs)} | ${x.peak} | ${f(x.analyticPeakBound)} | ${x.finite} |\n`;
md += '\nReverb tails are truncated exactly at `reverbTail` (comb gains are derived from the tail length, `|g| < 1` always); serial delay+reverb never exceeds the 3 s + 2 s budget.\n\n';

md += '## 6. Resource and memory upper bounds\n\n';
const m = r.memory;
md += '- All storage is preallocated Float32Array (4 bytes/sample); per-sample allocations: 0, no unbounded growth.\n';
md += '- Reverb processing is done in place inside the output buffer, so no separate reverb wet buffer is allocated.\n';
md += `- Max delay line (ring buffer): ${m.maxDelayRingSamples} samples (1 s).\n`;
md += `- Max delay tail after hard cap: ${m.maxDelayTailSamples} samples (3 s).\n`;
md += `- Max reverb tail: ${m.maxReverbTailSamples} samples (2 s).\n`;
md += '- Buffers per effects call (worst case): '
    + m.allocations.map(a => `${a.name}=${a.samples}`).join(', ') + '\n';
md += `- Predicted effect allocations: ${m.predictedEffectSamples} samples (${m.predictedEffectBytes} bytes, ${(m.predictedEffectBytes/1024).toFixed(1)} KiB); measured output length matches plan: ${bool(m.accountingMatches)}\n`;
md += `- Conservative worst case total including the dry input buffer: ${m.predictedEffectSamples + m.dryInputSamples} samples (${m.totalBytesIncludingDry} bytes, ${(m.totalBytesIncludingDry/1024).toFixed(1)} KiB).\n`;
md += '- The bound is O(n) in the dry input length; the tails are fixed-size and never grow.\n';
md += `- Maximum total tail length: ${m.maxTotalTailSeconds} s (3 s delay + 2 s reverb); tails can never run indefinitely.\n\n`;

md += '## 7. Overall result\n\n| Check | Pass |\n| --- | --- |\n';
md += `| comparison | ${bool(r.comparison.pass)} |\n`;
md += `| exactness | ${bool(r.exactness.pass)} |\n`;
md += `| failurePaths | ${bool(r.failurePaths.pass)} |\n`;
md += `| tailSets | ${bool(r.tailSets.pass)} |\n`;
md += `| stress | ${bool(r.stress.pass)} |\n`;
md += `| reverb | ${bool(r.reverb.pass)} |\n`;
md += `| memory accounting | ${bool(m.accountingMatches)} |\n`;

const outPath = fileURLToPath(new URL('../artifacts/effects-report.md', import.meta.url));
writeFileSync(outPath, md);
console.log(`wrote ${outPath}`);
