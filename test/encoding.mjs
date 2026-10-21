#!/usr/bin/env node
/**
 * Every Python entry point must survive a non-UTF-8 stdout.
 *
 * Windows runners default stdout to the console code page (cp1252). Any `print()` of
 * CJK then raises UnicodeEncodeError and the process exits 1 — after its assertions
 * have already passed, which makes it look like a test failure rather than an encoding
 * bug. That is exactly what turned Windows CI red twice while Linux stayed green.
 *
 * This runs each entry point under PYTHONIOENCODING=cp1252 and fails if it exits
 * non-zero. It cannot prove the fix on Windows, but it reproduces the trigger.
 *
 *   node test/encoding.cjs.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// Commands that print and take no corpus: safe to run anywhere, including CI.
const CHECKS = [
  ['elevation fidelity self-check', ['test/_elevation_fidelity.py', '--self-check']],
  ['elevation fidelity stats', ['test/_elevation_fidelity.py', '--stats']],
  ['elevation corpus check', ['test/_fidelity_corpus.py']],
];

let failed = 0;
for (const [label, args] of CHECKS) {
  const r = spawnSync('python', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'cp1252' },
  });
  const err = (r.stderr ?? '').trim();
  const encodingCrash = /UnicodeEncodeError|charmap/.test(err);
  if (r.status === 0 && !encodingCrash) {
    console.log(`ok    ${label} survives cp1252 stdout`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${encodingCrash ? ' — UnicodeEncodeError under cp1252' : ` exited ${r.status}`}`);
    if (err) console.log(`        ${err.split('\n').slice(-1)[0].slice(0, 160)}`);
    if (!err && r.stdout) console.log(`        ${String(r.stdout).trim().split('\n').slice(-1)[0].slice(0, 160)}`);
  }
}

console.log();
if (failed) {
  console.log(`${failed} FAILED — a Windows runner would go red here`);
  process.exit(1);
}
console.log('PASS: every Python entry point tolerates a cp1252 stdout');
