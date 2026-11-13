// Single repo-bundled validation entry point. Runs every check in sequence
// and tees a copy of the output to output/render/validation-log.txt.
'use strict';

import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {writeFileSync} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const steps = [
    ['1. golden reference (original engine @44.1k)', 'golden.mjs'],
    ['2. bit-identical 44.1k regression',            'check-identity.mjs'],
    ['3. cross-rate consistency (44.1k vs 48k)',     'cross-rate.mjs'],
    ['4. wav export at both sample rates',           'wav-export.mjs'],
    ['5. render timing benchmark',                   'benchmark.mjs'],
];

let log = '';
let failed = 0;
for (const [title, script] of steps)
{
    const banner = `\n===== ${title} =====`;
    console.log(banner);
    log += banner + '\n';
    const result = spawnSync(process.execPath, [join(here, script)], {encoding: 'utf8'});
    process.stdout.write(result.stdout);
    log += result.stdout;
    if (result.stderr) { process.stderr.write(result.stderr); log += result.stderr; }
    if (result.status !== 0) failed++;
}

const summary = `\n===== summary: ${steps.length - failed}/${steps.length} step(s) passed =====\n`;
console.log(summary);
log += summary;
writeFileSync(join(here, '..', 'render', 'validation-log.txt'), log);
process.exitCode = failed ? 1 : 0;
