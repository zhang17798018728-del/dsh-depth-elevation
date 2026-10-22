#!/usr/bin/env node
/**
 * One command after a restart: did the plugin survive it?
 *
 * A restart is the only moment where "it worked yesterday" stops being evidence.
 * Three different things can be true the next morning, and they need three
 * different checks — this runs all of them and reports each verdict separately,
 * because "the tests pass" is not the same claim as "the running host is gating":
 *
 *   suites  — `test/all.mjs`: the shipping code still behaves
 *   mount   — `tools/verify_elevation_plugin.py`: the profile still composes the row,
 *             the runtime path is still a live junction, the old hook is retired
 *   live    — `tools/live_probe.mjs --json`: the RUNNING host has an ACTIVE fiber, its
 *             handler is registered, it gates a substantive prompt, and the live
 *             matcher honours the fixture table
 *
 * Only `live` needs the host awake, so this waits for it first (a restart that
 * finishes mid-check would otherwise look like a plugin failure). If the host never
 * appears, or its Inspector is off, that layer reports UNAVAILABLE and the process
 * exits 2 — never PASS. A skipped layer must not read as a green one.
 *
 * The live layer is consumed as JSON, not scraped from its human output: the probe
 * owns one `checks[]` array and this file renders it, so a renamed field breaks the
 * build instead of silently printing "(no output)".
 *
 *   node tools/post-restart-check.mjs              # wait up to 120s for the host
 *   node tools/post-restart-check.mjs --timeout=300
 *   node tools/post-restart-check.mjs --no-live    # static layers only (exit 2)
 *
 * Exit: 0 all layers pass · 1 a layer failed · 2 host/Inspector unavailable
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { PROBE_VERSION } from './probe-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const RUNNING = join(homedir(), '.dsh', 'dsh-config-manager', 'running', 'desktop.json');
const INSPECTOR_PORT = Number(process.env.DSH_INSPECTOR_PORT ?? 9230);

const args = process.argv.slice(2);
const timeoutSec = Number((args.find((a) => a.startsWith('--timeout=')) ?? '--timeout=120').split('=')[1]);
const skipLive = args.includes('--no-live');

const line = (label, verdict, detail) => console.log(`${verdict.padEnd(5)} ${label.padEnd(7)} ${detail}`);

/** Run a command and return { ok, stdout, stderr }. */
function exec(command, commandArgs) {
  const r = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/** First non-empty line that is not a bare brace — a summary, never a JSON fragment. */
const tailLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '(no output)';

function runSuites() {
  const started = Date.now();
  const r = exec(process.execPath, [join(HERE, '..', 'test', 'all.mjs')]);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  line('suites', r.ok ? 'PASS' : 'FAIL', `${tailLine(r.stdout)} [${secs}s]`);
  if (!r.ok) {
    for (const bad of r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 6)) {
      console.log(`        ${bad}`);
    }
  }
  return r.ok;
}

function runMount() {
  const started = Date.now();
  const r = exec('python', [join(HERE, 'verify_elevation_plugin.py')]);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  line('mount', r.ok ? 'PASS' : 'FAIL', `${tailLine(r.stdout)} [${secs}s]`);
  if (!r.ok) {
    for (const bad of r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 6)) {
      console.log(`        ${bad}`);
    }
  }
  return r.ok;
}

/**
 * The live layer, consumed as structured output.
 *
 * A payload the probe did not produce in the shape this file expects is a FAIL, not
 * a crash and not a pass: that is how a renamed field or a stray `console.log` in the
 * probe gets caught by the very command that depends on it.
 */
function runLive() {
  const started = Date.now();
  const r = exec(process.execPath, [join(HERE, 'live_probe.mjs'), '--json']);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch (error) {
    line('live', 'FAIL', `unparseable --json output: ${String(error.message).slice(0, 80)} [${secs}s]`);
    const first = r.stdout.trim().split('\n')[0] ?? '(empty stdout)';
    console.log(`        first line: ${first.slice(0, 120)}`);
    return false;
  }

  if (payload.version !== PROBE_VERSION) {
    line('live', 'FAIL', `probe payload version ${payload.version}, expected ${PROBE_VERSION} — shape changed [${secs}s]`);
    return false;
  }
  if (payload.reason === 'inspector-unreachable') {
    line('live', 'UNAVAIL', `no CDP target on 127.0.0.1:${INSPECTOR_PORT} — is experimental-inspector enabled?`);
    return null;
  }

  if (payload.ok) {
    line('live', 'PASS',
      `fiber=${payload.fiberState} handlers=${payload.preStepHandlers} `
      + `matcher=${payload.matcher?.passed}/${payload.matcher?.total} `
      + `gate=${payload.gatedClause} latch-restored=${payload.latchRestored} [${secs}s]`);
    return true;
  }

  line('live', 'FAIL', `${payload.reason ?? 'not healthy'} [${secs}s]`);
  // The probe's own checks[] is the report — this file renders it, never re-derives it.
  for (const check of payload.checks ?? []) {
    if (!check.ok) console.log(`        FAIL ${check.id}: ${check.detail}`);
  }
  if (payload.hint) console.log(`        ${payload.hint}`);
  return false;
}

async function runningPid() {
  try {
    const { pid } = JSON.parse(await readFile(RUNNING, 'utf8'));
    process.kill(pid, 0); // throws when the pid is gone; a stale file is not "running"
    return pid;
  } catch {
    return null;
  }
}

async function inspectorUp() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    return Array.isArray(targets) && targets.some((t) => t.type === 'page');
  } catch {
    return false;
  }
}

async function waitForHost(seconds) {
  const deadline = Date.now() + seconds * 1000;
  process.stdout.write(`      waiting for host (up to ${seconds}s)…`);
  while (Date.now() < deadline) {
    const pid = await runningPid();
    if (pid && await inspectorUp()) {
      process.stdout.write(` up (pid ${pid})\n`);
      return { pid, inspector: true };
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stdout.write('\n');
  return { pid: await runningPid(), inspector: await inspectorUp() };
}

console.log(`post-restart self-check  ${new Date().toISOString()}`);
console.log();

const results = [];

// 1. Shipping code still behaves. Host-independent. `verify_elevation_plugin.py`
//    below runs this same suite as its own second layer; the duplication is
//    deliberate — separate verdicts say which layer broke.
results.push({ label: 'suites', ok: runSuites() });

// 2. Profile still composes the row and points at this working tree.
results.push({ label: 'mount', ok: runMount() });

// 3. The running host: the only layer that can see a mount that failed at boot.
if (skipLive) {
  // A skipped layer must never read as a pass (CONTRIBUTING.md). Static layers can
  // be green while the running host is broken; say so and exit incomplete.
  line('live', 'SKIP', '(--no-live: the running-host layer was not checked)');
  results.push({ label: 'live', ok: null, unavailable: 'skipped-by-flag' });
} else {
  const host = await waitForHost(timeoutSec);
  if (!host.pid) {
    line('live', 'UNAVAIL', 'host not running — the live layer needs an awake Host, not a passing one');
    results.push({ label: 'live', ok: null, unavailable: 'host-not-running' });
  } else if (!host.inspector) {
    line('live', 'UNAVAIL', `no CDP target on 127.0.0.1:${INSPECTOR_PORT} — is experimental-inspector enabled?`);
    results.push({ label: 'live', ok: null, unavailable: 'inspector-disabled' });
  } else {
    const live = runLive();
    results.push({ label: 'live', ok: live, ...(live === null ? { unavailable: 'inspector-disabled' } : {}) });
  }
}

console.log();
const failed = results.filter((r) => r.ok === false);
const unavailable = results.filter((r) => r.ok === null);
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.label).join(', ')}`);
  process.exit(1);
}
if (unavailable.length) {
  console.log(`INCOMPLETE: ${unavailable.map((r) => `${r.label} (${r.unavailable})`).join(', ')} — not a pass`);
  process.exit(2);
}
console.log('PASS: shipping code, profile mount, and the live host all agree the plugin is working');
process.exit(0);
