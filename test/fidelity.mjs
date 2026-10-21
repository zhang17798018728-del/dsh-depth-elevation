#!/usr/bin/env node
/**
 * Elevation fidelity: after the user picks 升维, does the model actually
 * produce the rewritten prompt the instruction demands?
 *
 * The one layer decide/apply/e2e/regress cannot cover: they prove the gate
 * fires and the instruction is well-formed, not that the instruction WORKS.
 * docs/RULE-SCIENCE.md measured 0/3 execution before the artifact demand was
 * added; this suite is how that number gets watched from now on.
 *
 * Two layers:
 *   1. self-check — synthetic fixtures with known answers, runs everywhere
 *      (CI-safe, no corpus, no peers). Proves the extractor itself.
 *   2. corpus scan — real sessions on this machine. Hard rule:
 *      every post-R13 (new-era) elevated turn whose model produced a visible
 *      reply MUST deliver all four artifact parts. no-reply turns (provider
 *      interruption) are counted, not asserted — an interrupted turn is not
 *      evidence either way.
 *
 * No samples yet is a reported state, not a pass and not a fail: the plugin
 * was rebuilt today, and a fake green would be worse than no number.
 *
 *   node test/fidelity.mjs
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '_elevation_fidelity.py');
// Same override the Python scanner honours, so the end-to-end path (corpus dir ->
// zstd files -> rows -> rate -> verdict) can be exercised against a synthetic corpus.
// Defaults to the real session store, which is what CI and normal runs measure.
const SESSIONS = process.env.DSH_FIDELITY_SESSIONS
  || join(homedir(), '.dsh', 'sessions');

let failed = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failed += 1;
};

function sessionCorpusExists() {
  return existsSync(SESSIONS) && statSync(SESSIONS).isDirectory()
    && readdirSync(SESSIONS).some((d) => statSync(join(SESSIONS, d)).isDirectory());
}

// ---------------------------------------------------------------------------
// 1. Self-check — the extractor proves itself against known answers
// ---------------------------------------------------------------------------

let selfOk = false;
try {
  const out = execFileSync('python', [SCRIPT, '--self-check'], { encoding: 'utf8' });
  process.stdout.write(out.split('\n').map((l) => `  ${l}`).join('\n'));
  selfOk = true;
} catch (error) {
  fail(`fidelity self-check failed: ${String(error.message).slice(0, 160)}`);
}
if (selfOk) console.log('  self-check: extractor proves pass/fail/no-reply/era/direct-skip');

// ---------------------------------------------------------------------------
// 2. Corpus scan — the number that turns belief into measurement
// ---------------------------------------------------------------------------

let rows = null;
let neoAnswered = 0;
if (sessionCorpusExists()) {
  try {
    rows = JSON.parse(execFileSync('python', [SCRIPT], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch (error) {
    fail(`fidelity corpus scan unavailable: ${String(error.message).slice(0, 160)}`);
  }
} else {
  console.log('corpus scan: skipped (no local dsh session corpus on this machine)');
}

if (rows) {
  const byEra = { new: [], legacy: [], unattributed: [] };
  for (const row of rows) (byEra[row.era] ?? byEra.unattributed).push(row);

  const report = (label, eraRows) => {
    const pass = eraRows.filter((r) => r.outcome === 'pass');
    const fails = eraRows.filter((r) => r.outcome === 'fail');
    const noreply = eraRows.filter((r) => r.outcome === 'no-reply');
    const answered = pass.length + fails.length;
    const rate = answered ? ` (${pass.length}/${answered} = ${Math.round(100 * pass.length / answered)}%)` : '';
    console.log(`  ${label.padEnd(7)} elevated=${eraRows.length} pass=${pass.length} `
      + `fail=${fails.length} no-reply=${noreply.length}  artifact rate${rate}`);
    return { pass, fails, noreply };
  };

  const neo = report('new', byEra.new);
  report('legacy', byEra.legacy);
  if (byEra.unattributed.length) report('unattrib', byEra.unattributed);

  for (const row of neo.fails.slice(0, 5)) {
    console.log(`  fail  ${row.sid.slice(0, 24)} markers=${row.markers} :: ${row.excerpt?.slice(0, 70)}`);
  }

  const answered = neo.pass.length + neo.fails.length;
  neoAnswered = answered;
  if (answered === 0) {
    console.log('  new-era: no answered elevated turns yet — collecting sessions, nothing asserted');
  } else if (neo.fails.length > 0) {
    // The instruction promises the artifact. A post-fix miss is a broken
    // promise, not a rate to be negotiated.
    fail(`${neo.fails.length}/${answered} new-era elevated replies missed the artifact (must be 0)`);
  } else {
    console.log(`  new-era: ${neo.pass.length}/${answered} delivered the full artifact (100%)`);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
// Never overclaim a layer. Three distinct outcomes, and the wording must match the
// one that happened: extractor proven, corpus scanned with no samples yet, or corpus
// scanned with real post-fix evidence.
if (rows === null) {
  console.log('PASS: elevation fidelity extractor verified (corpus scan SKIPPED — no session corpus)');
} else if (typeof neoAnswered === 'number' && neoAnswered > 0) {
  console.log('PASS: elevation fidelity measured on post-fix sessions');
} else {
  console.log('PASS: elevation fidelity extractor verified (corpus scanned, NO post-fix samples yet — nothing asserted)');
}
