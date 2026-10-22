/**
 * The suite list: ONE definition, several readers.
 *
 * `test/all.mjs` runs this list. `test/docs.mjs` asserts the READMEs describe exactly
 * this set, that every command and path they mention exists, and that no hand-written
 * count has slipped back in. When those were separate lists they drifted: the README
 * claimed "four suites" while seven were running, and the numeral was hand-edited
 * twice in one session before anyone noticed.
 *
 * Adding a suite means adding it here. The docs guard then fails until the README
 * tables match, so documentation cannot go stale silently — it can only go red.
 *
 * @module test/suites
 */

/**
 * @typedef {object} Suite
 * @property {string} label - short name; also the label both README tables must list
 * @property {string} file  - entry file, relative to this directory
 * @property {string[]} args - extra argv for that entry file
 */

/** @type {Suite[]} */
export const SUITES = [
  { label: 'decide', file: 'decide.test.mjs', args: [] },
  { label: 'apply', file: 'apply.test.mjs', args: [] },
  { label: 'e2e', file: 'e2e.mjs', args: [] },
  { label: 'regress', file: 'regressions.mjs', args: [] },
  { label: 'fidelity', file: 'fidelity.mjs', args: [] },
  { label: 'encoding', file: 'encoding.mjs', args: [] },
  // The restart check's live layer needs a running Host, so only its verdict
  // function is exercised in CI. Judge drift is then caught by `npm test`, not by
  // a green-looking no-op on someone's desktop.
  { label: 'live', file: '../tools/live_probe.mjs', args: ['--self-check'] },
  // The machine-readable contract between the probe and its parent: one JSON object
  // on stdout, both modes distinguishable. Runs without a host (exit 2 is itself a
  // valid payload), so it belongs in CI even though the live layer does not.
  { label: 'contract', file: 'contract.mjs', args: [] },
  // Guards the two README tables against this list. Declared last and checks its own
  // row exists, so deleting a README row cannot be a way to make the guard pass.
  { label: 'docs', file: 'docs.mjs', args: [] },
];

/** Labels, in declaration order. */
export const LABELS = SUITES.map((suite) => suite.label);

