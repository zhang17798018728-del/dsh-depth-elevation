#!/usr/bin/env node
/**
 * Prove the new-era fidelity path works on real transcripts, then clean up.
 *
 * `test/fidelity.mjs` only ever ran its `new` branch against `--self-check` fixtures,
 * which call `analyze_events()` directly. The zstd file plumbing, the `--stats`
 * aggregation and the hard-fail verdict were never exercised with post-R13 data — the
 * real corpus has zero such samples.
 *
 * `test/_fidelity_corpus.py` closes that gap: it plants a synthetic corpus in the exact
 * on-disk shape the harness writes, points the scanner at it, and asserts the scoring
 * end to end. This is the runnable check for that scenario, so it can be re-run after
 * any change to the scanner.
 *
 *   node test/fidelity.corpus.mjs          # build, verify, clean up
 *   node test/fidelity.corpus.mjs --keep   # leave the synthetic corpus on disk
 *
 * Not part of test/all.mjs: it writes files under .tmp/ and shells to Python, while
 * test/all.mjs stays read-only on the repository. CI runs it as its own step.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILDER = join(HERE, '_fidelity_corpus.py');
const CORPUS = join(dirname(HERE), '.tmp', 'fidelity-corpus');
const keep = process.argv.includes('--keep');

let failed = 0;
const fail = (m) => { console.log(`FAIL  ${m}`); failed += 1; };

// 1. Build the synthetic corpus and verify the scoring in one shot.
const built = spawnSync('python', [BUILDER], { encoding: 'utf8' });
process.stdout.write(built.stdout ?? '');
if (built.status !== 0) {
  if (built.stderr) console.log(String(built.stderr).slice(0, 600));
  fail('synthetic new-era corpus did not verify');
}

// 2. The JS verdict path must HARD-FAIL on that corpus, because it contains planted
//    post-R13 misses. A suite that only proves "pass" cases would not prove the guard.
if (existsSync(CORPUS)) {
  const strict = spawnSync(process.execPath, [join(HERE, 'fidelity.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_FIDELITY_SESSIONS: CORPUS },
  });
  const exitedOne = strict.status === 1;
  const named = /missed the artifact \(must be 0\)/.test(strict.stdout ?? '');
  if (exitedOne && named) {
    console.log('ok    fidelity.mjs hard-fails on planted post-fix misses');
  } else {
    fail(`fidelity.mjs did not hard-fail on planted misses (status=${strict.status})`);
  }
} else {
  fail('synthetic corpus was not created');
}

// 3. The real corpus must still be untouched by any of this.
const real = spawnSync(process.execPath, [join(HERE, 'fidelity.mjs')], {
  encoding: 'utf8',
  env: { ...process.env, DSH_FIDELITY_SESSIONS: '' },
});
if (real.status === 0) {
  console.log('ok    the real corpus still passes (synthetic run left no residue)');
} else {
  fail('the real corpus run regressed');
}

if (!keep) {
  try { rmSync(CORPUS, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log();
if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log('PASS: new-era fidelity scoring verified end to end on synthetic transcripts');
