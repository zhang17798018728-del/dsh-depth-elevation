#!/usr/bin/env node
/**
 * One command that proves dsh-depth-elevation works end to end.
 *
 *   node test/all.mjs
 *
 * Layers, each catching a different failure mode:
 *   1. decide — pure matcher: 18 curated cases, config knobs, and a replay of
 *               every real user turn since the rule was installed. Catches
 *               over-firing and under-firing on data the author did not write.
 *   2. apply  — the shipping apply() against a fake Cordis ctx. Catches broken
 *               seam registration, lost prompts, and missing dedupe.
 *   3. e2e    — a realistic multi-message batch walked through the seam. Catches
 *               ordering and provenance mistakes a unit test cannot see.
 *
 * The three suites need the @deepseek-ai/* peers to import lib/index.js. In a
 * real profile the harness supplies those; for a standalone run, materialise
 * them once first:
 *
 *   python tools/asar_peers.py ~/.dsh/plugins/dsh-depth-elevation/node_modules \
 *       @deepseek-ai/dsh-llm @deepseek-ai/schemastery @deepseek-ai/cordis
 *
 * If they are missing the suites fail with a clear module error rather than
 * silently skipping — a skipped layer must never read as a pass.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  ['decide', 'decide.test.mjs'],
  ['apply', 'apply.test.mjs'],
  ['e2e', 'e2e.mjs'],
  ['regress', 'regressions.mjs'],
  ['fidelity', 'fidelity.mjs'],
];

let failed = 0;
for (const [label, file] of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, file)], { encoding: 'utf8' });
  const lines = (r.stdout ?? '').trim().split('\n').filter(Boolean);
  const verdict = lines[lines.length - 1] ?? '(no output)';
  const ok = r.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(7)} ${verdict}`);
  if (!ok) {
    const bad = lines.filter((l) => l.startsWith('FAIL'));
    if (bad.length) console.log(bad.map((l) => `        ${l}`).join('\n'));
    if (r.stderr) console.log(`        ${String(r.stderr).split('\n')[0]}`);
  }
}

console.log();
if (failed) {
  console.log(`${failed} of ${SUITES.length} suites failed`);
  process.exit(1);
}
console.log(`all ${SUITES.length} suites passed`);
