/**
 * The machine-readable contract: `tools/live_probe.mjs --json` emits exactly ONE
 * JSON object on stdout, and `tools/post-restart-check.mjs` can consume it.
 *
 * Why this exists as its own suite: the parent process parses the child's whole
 * stdout. A single stray `console.log` — the kind added while debugging a probe and
 * forgotten — makes that parse throw, and the failure looks like "the live layer is
 * broken" rather than "the probe printed a line it promised not to". Proven by
 * mutation: inserting one `console.log` before the JSON write makes the whole-stdout
 * parse reject.
 *
 * Runs WITHOUT a host and must not pass by accident: a missing Host is still a valid
 * JSON payload (`reason: inspector-unreachable`, exit 2). The contract is about the
 * shape of stdout, not about the host being up, so both outcomes are checked here and
 * the assertion is on the payload, never on the exit code alone.
 *
 *   node test/contract.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PROBE_VERSION, REQUIRED_FIELDS } from '../tools/probe-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let failed = 0;
const fail = (message) => {
  console.log(`FAIL  ${message}`);
  failed += 1;
};
const ok = (message) => console.log(`ok    ${message}`);

/** Run the probe in JSON mode and parse the WHOLE stdout, exactly as the parent does. */
function probeJson(extraArgs = []) {
  const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'live_probe.mjs'), '--json', ...extraArgs], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- 1. exactly one parseable object, whatever the host is doing -------------
const live = probeJson();
let payload;
try {
  payload = JSON.parse(live.stdout);
  ok('live: whole stdout parses as one JSON object');
} catch (error) {
  const first = live.stdout.trim().split('\n')[0] ?? '(empty stdout)';
  fail(`live: stdout is not a single JSON object (${String(error.message).slice(0, 60)}); first line: ${first.slice(0, 120)}`);
}

if (payload) {
  if (payload.version !== PROBE_VERSION) fail(`live: payload version ${payload.version}, expected ${PROBE_VERSION}`);
  else ok(`live: payload matches contract version ${PROBE_VERSION}`);

  const missing = REQUIRED_FIELDS.filter((field) => !(field in payload));
  if (missing.length) fail(`live: payload omits required field(s) ${missing.join(', ')}`);
  else ok(`live: payload carries every required field (${REQUIRED_FIELDS.join(', ')})`);

  if (typeof payload.ok !== 'boolean') fail('live: payload.ok is not a boolean');
  else ok('live: payload.ok is a boolean');

  // A healthy run and an unavailable host both have to be describable; anything
  // else (a crash, a partial write) has to be visible as such rather than as `{}`.
  const known = [0, 1, 2];
  if (!known.includes(live.status)) fail(`live: exit ${live.status} is outside the documented 0/1/2`);
  else ok(`live: exit ${live.status} is within the documented set`);

  if (live.status === 0) {
    if (!Array.isArray(payload.checks) || payload.checks.length === 0) {
      fail('live: healthy run has no checks[] to report');
    } else {
      const malformed = payload.checks.filter((c) => typeof c?.id !== 'string' || typeof c?.ok !== 'boolean');
      if (malformed.length) fail(`live: ${malformed.length} malformed check row(s)`);
      else ok(`live: ${payload.checks.length} checks, each with id and ok`);
    }
    if (!Array.isArray(payload.problems)) fail('live: problems is not an array');
    else if (payload.problems.length) fail('live: ok=true but problems is non-empty');
    else ok('live: ok=true agrees with an empty problems list');
  } else {
    // Exit 2 = no host / no Inspector. That is a REPORTED outcome, not a failure of
    // the contract, so it must still carry a reason.
    if (!payload.reason) fail(`live: exit ${live.status} without a reason`);
    else ok(`live: exit ${live.status} reports reason "${payload.reason}"`);
  }

  // stderr is allowed (diagnostics), stdout is not: nothing may follow the object.
  const trailing = live.stdout.slice(live.stdout.indexOf('\n') + 1).trim();
  if (trailing) fail(`live: ${trailing.length} byte(s) follow the JSON object on stdout`);
}

// --- 2. the parent can consume it, unmodified --------------------------------
// Same parse the parent performs, over the same bytes: if this disagrees with the
// parent, one of them changed shape without the other.
const parentShaped = (() => {
  try {
    const parsed = JSON.parse(live.stdout);
    return parsed.version === PROBE_VERSION ? parsed : null;
  } catch {
    return null;
  }
})();
if (!parentShaped) fail('live: the parent\'s exact parse (version gate included) would reject this payload');
else ok('live: parent-compatible after the version gate');

// --- 3. human mode still works and is not mistaken for JSON -----------------
const human = spawnSync(process.execPath, [join(ROOT, 'tools', 'live_probe.mjs')], { encoding: 'utf8' });
if (!['0', '1', '2'].includes(String(human.status))) fail(`live: human mode exited ${human.status}`);
else if (!human.stdout.trim()) fail('live: human mode printed nothing');
else if (human.stdout.trim().startsWith('{')) fail('live: human mode looks like JSON — the two modes must stay distinguishable');
else ok('live: human mode prints prose and stays distinguishable from --json');

console.log();
if (failed) {
  console.log(`${failed} contract check(s) failed`);
  process.exit(1);
}
console.log('PASS: --json emits exactly one parseable object and both modes stay distinguishable');
