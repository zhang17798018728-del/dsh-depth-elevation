#!/usr/bin/env node
/**
 * One command after a restart: did the plugin survive it?
 *
 * A restart is the only moment where "it worked yesterday" stops being evidence.
 * Three different things can be true the next morning, and they need three
 * different checks — this runs all of them and reports each verdict separately,
 * because "the tests pass" is not the same claim as "the running host is gating":
 *
 *   suites  — `test/all.mjs`: the shipping code still behaves (decide/apply/e2e/…)
 *   mount   — `tools/verify_elevation_plugin.py`: the profile still composes the row,
 *             the runtime path is still a live junction, the old hook is still retired
 *   live    — `tools/live_probe.mjs`: the RUNNING host has an ACTIVE fiber, its
 *             handler is registered, it gates a substantive prompt, and the live
 *             matcher honours the fixture table
 *
 * Only `live` needs the host awake, so this waits for it first (a restart that
 * finishes mid-check would otherwise look like a plugin failure). If the host
 * never appears, or its Inspector is off, that layer reports UNAVAILABLE and the
 * process exits 2 — never PASS. A skipped layer must not read as a green one.
 *
 *   node tools/post-restart-check.mjs              # wait up to 120s for the host
 *   node tools/post-restart-check.mjs --timeout=300
 *   node tools/post-restart-check.mjs --no-live    # static layers only (CI-safe)
 *
 * Exit: 0 all layers pass · 1 a layer failed · 2 host/Inspector unavailable
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const RUNNING = join(homedir(), '.dsh', 'dsh-config-manager', 'running', 'desktop.json');
const INSPECTOR_PORT = Number(process.env.DSH_INSPECTOR_PORT ?? 9230);

const args = process.argv.slice(2);
const timeoutSec = Number((args.find((a) => a.startsWith('--timeout=')) ?? '--timeout=120').split('=')[1]);
const skipLive = args.includes('--no-live');

const line = (label, verdict, detail) => console.log(`${verdict.padEnd(5)} ${label.padEnd(7)} ${detail}`);

/** Run a command, return { ok, verdict, tail }. */
function run(label, command, commandArgs, opts = {}) {
  const started = Date.now();
  const r = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8', ...opts });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  const lines = out.split('\n').filter(Boolean);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const summary = summarise(label, out, lines);
  line(label, r.status === 0 ? 'PASS' : 'FAIL', `${summary} [${secs}s]`);
  if (r.status !== 0) {
    for (const bad of lines.filter((l) => /^(FAIL|PASS\s+\S+\s+FAIL:)/.test(l)).slice(0, 6)) {
      console.log(`        ${bad}`);
    }
  }
  return { ok: r.status === 0, out };
}

/**
 * The live layer prints JSON, whose last line is `}`. Reporting that as the verdict
 * summary would hide exactly the numbers a restart check exists to show.
 */
function summarise(label, out, lines) {
  if (label !== 'live') return lines[lines.length - 1] ?? '(no output)';
  try {
    const parsed = JSON.parse(out);
    if (!parsed.ok) return `not healthy: ${(parsed.problems ?? [parsed.reason ?? 'unknown']).join('; ')}`;
    return `fiber=${parsed.fiberState} handlers=${parsed.preStepHandlers} matcher=${parsed.matcher} gate=${parsed.gatedClause} latch-restored=${parsed.latchRestored}`;
  } catch {
    return lines[lines.length - 1] ?? '(no output)';
  }
}

/** The Host writes running/desktop.json while a profile runtime is live. */
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
  const pid = await runningPid();
  return { pid, inspector: await inspectorUp() };
}

console.log(`post-restart self-check  ${new Date().toISOString()}`);
console.log();

const results = [];

// 1. Shipping code still behaves. Host-independent.
//    `verify_elevation_plugin.py` below runs this same suite as its own second layer.
//    That duplication is deliberate: it costs ~50s and keeps the two verdicts
//    separate, so a red run says which layer broke instead of blaming the mount for
//    a math error in the matcher.
results.push({ label: 'suites', ...run('suites', process.execPath, [join(HERE, '..', 'test', 'all.mjs')]) });

// 2. Profile still composes the row and points at this working tree. Host-independent
//    in principle, but the mount check drives the installed Electron binary.
results.push({ label: 'mount', ...run('mount', 'python', [join(HERE, 'verify_elevation_plugin.py')]) });

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
    results.push({ label: 'live', ...run('live', process.execPath, [join(HERE, 'live_probe.mjs')]) });
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
