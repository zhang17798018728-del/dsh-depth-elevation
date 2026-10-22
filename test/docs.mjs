#!/usr/bin/env node
/**
 * Documentation guard: the docs describe the code that exists.
 *
 * Every one of these was a real defect in this repo, found by reading rather than by
 * running, and each is the kind that stays wrong for months:
 *
 *   - the README said "four suites" while `test/all.mjs` ran seven, because the
 *     sentence was hand-edited instead of derived;
 *   - a doc named `npm run check:live:self` that did exist, and a `tools/*.mjs` that
 *     `package.json` referenced and nobody had added yet;
 *   - counts of fixtures and assertions sprinkled through prose, drifting one
 *     commit behind the code they described.
 *
 * So this suite asserts three things, all mechanical:
 *
 *   1. both READMEs list exactly the suites in `test/suites.mjs` (same set, no more,
 *      no fewer) — inside `<!-- suites:begin/end -->` anchors, because markdown
 *      tables sit next to headings that look alike and a header regex would bind to
 *      the wrong table the moment one is inserted above;
 *   2. every `npm run <script>` and every `tools/…` file path named in the docs
 *      resolves;
 *   3. no hand-written count of suites survives anywhere in prose.
 *
 * A guard that can be satisfied by deleting the docs is not a guard: the anchors and
 * the table header are required, so removing them fails too.
 *
 *   node test/docs.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LABELS, SUITES } from './suites.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const DOCS = ['README.md', 'README.en.md', 'CONTRIBUTING.md'];
// Path relative to this directory, matching how `test/suites.mjs` declares entries.
const SELF = 'docs.mjs';

/**
 * Counts that must never be spelled out in prose, because prose cannot be derived.
 * Each pattern is a shape that only occurs when someone wrote the number by hand.
 * Every pattern MUST carry the `g` flag — `matchAll` rejects a non-global regexp, and
 * asserting that here is cheaper than a guard that dies instead of reporting.
 */
const FORBIDDEN_COUNTS = [
  [/\b(three|four|five|six|seven|eight|nine|ten)\s+suites\b/gi, 'spelled-out suite count'],
  [/(三|四|五|六|七|八|九|十)套(测试|套件)/g, '手写的套件数量'],
  [/\ball\s+(three|four|five|six|seven|eight|nine|ten)\s+suites\b/gi, '手写的套件数量'],
  [/\b\d+\s+(known-answer\s+)?fixtures?\b/gi, '手写的 fixture 数量'],
  [/\b\d+\s*条\s*(fixture|fixtures)/gi, '手写的 fixture 数量'],
];

for (const [pattern] of FORBIDDEN_COUNTS) {
  if (!pattern.global) throw new Error(`FORBIDDEN_COUNTS pattern is not global: ${pattern}`);
}

let failed = 0;
const fail = (message) => {
  console.log(`FAIL  ${message}`);
  failed += 1;
};
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

// ---------------------------------------------------------------------------
// 1. Both READMEs list exactly the suites that run
// ---------------------------------------------------------------------------

/** Labels from the anchored suite table, in order. */
function documentedSuites(file) {
  const text = read(file);
  const begin = text.indexOf('<!-- suites:begin -->');
  const end = text.indexOf('<!-- suites:end -->');
  if (begin === -1 || end === -1 || end < begin) return null;
  const block = text.slice(begin, end);
  // Row form: | `label` | what it checks |  — labels may contain digits (`e2e`).
  return [...block.matchAll(/^\|\s*`([a-z][\w-]*)`\s*\|/gm)].map((match) => match[1]);
}

for (const file of ['README.md', 'README.en.md']) {
  const documented = documentedSuites(file);
  if (documented === null) {
    fail(`${file}: missing <!-- suites:begin -->/<!-- suites:end --> anchors or the table between them`);
    continue;
  }
  const missing = LABELS.filter((label) => !documented.includes(label));
  const extra = documented.filter((label) => !LABELS.includes(label));
  if (missing.length) fail(`${file}: table omits suite(s) ${missing.join(', ')}`);
  if (extra.length) fail(`${file}: table lists suite(s) that do not run: ${extra.join(', ')}`);
  const duplicated = documented.filter((label, index) => documented.indexOf(label) !== index);
  if (duplicated.length) fail(`${file}: duplicate row(s) ${[...new Set(duplicated)].join(', ')}`);
  if (!missing.length && !extra.length && !duplicated.length) {
    console.log(`PASS  ${file}: suite table lists all ${LABELS.length} suites`);
  }
}

// ---------------------------------------------------------------------------
// 2. Every command and path the docs name actually exists
// ---------------------------------------------------------------------------

const manifest = JSON.parse(read('package.json'));
const scripts = new Set(Object.keys(manifest.scripts ?? {}));

for (const file of DOCS) {
  const text = read(file);

  for (const match of text.matchAll(/npm run ([\w:.-]+)/g)) {
    if (!scripts.has(match[1])) fail(`${file}: documents \`npm run ${match[1]}\`, which package.json does not define`);
  }

  // `node tools/x.mjs`, `python tools/y.py`, with optional extra args.
  for (const match of text.matchAll(/\b(?:node|python3?)\s+(tools\/[\w.-]+\.(?:mjs|js|py))/g)) {
    if (!existsSync(join(ROOT, match[1]))) fail(`${file}: names ${match[1]}, which does not exist`);
  }

  // Bare backticked tools/ paths in tables and prose.
  for (const match of text.matchAll(/`(tools\/[\w.-]+\.(?:mjs|js|py))`/g)) {
    if (!existsSync(join(ROOT, match[1]))) fail(`${file}: names ${match[1]}, which does not exist`);
  }
}
console.log('PASS  every documented npm script and tools/ path resolves');

// ---------------------------------------------------------------------------
// 3. No hand-written counts left in prose
// ---------------------------------------------------------------------------

for (const file of DOCS) {
  const text = read(file);
  for (const [pattern, label] of FORBIDDEN_COUNTS) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      fail(`${file}:${line}: ${label} "${match[0]}" — derive it from test/suites.mjs instead`);
    }
  }
}
if (!failed) console.log('PASS  no hand-written suite or fixture counts in the docs');

// ---------------------------------------------------------------------------
// 4. The list this suite is part of is itself listed once
// ---------------------------------------------------------------------------

const selfDeclared = SUITES.filter((suite) => suite.file === SELF);
if (selfDeclared.length !== 1) fail(`test/suites.mjs must declare ${SELF} exactly once (found ${selfDeclared.length})`);

// Every suite entry must point at a file that exists; a typo here would otherwise
// surface as a confusing module-not-found from a child process.
for (const suite of SUITES) {
  const path = join(HERE, suite.file);
  if (!existsSync(path)) fail(`test/suites.mjs: suite "${suite.label}" points at missing file ${suite.file}`);
}

console.log();
if (failed) {
  console.log(`${failed} docs check(s) failed`);
  process.exit(1);
}
console.log('PASS: docs describe the code that exists');
