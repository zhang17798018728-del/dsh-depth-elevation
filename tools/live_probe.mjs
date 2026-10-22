/**
 * Post-restart live check: is dsh-depth-elevation actually loaded and gating in the
 * RUNNING host?
 *
 * `tools/verify_elevation_plugin.py` proves the profile *would* compose the plugin
 * row — from files, without a host. It cannot see the three failures a restart
 * actually causes: a plugin that mounted and then failed, a config left disabled, or
 * a hook registered into the wrong context. This probe attaches to the Host's own
 * Inspector (CDP, default port 9230) and asks the live Cordis runtime, then drives
 * the registered `agent/pre-step` handler and checks what it appended.
 *
 * Checks, in order:
 *   1. a Fiber named `dsh-depth-elevation` exists and is ACTIVE (state 2)
 *   2. its config is enabled and its declared `agents` service resolved
 *   3. exactly one `agent/pre-step` handler sits under its own ctx
 *   4. that handler appends an instruction stamped `source.kind = 'depth-elevation'`
 *      to a substantive prompt, keeps the user's message first, and leaves `收到` alone
 *   5. the live matcher (`decideGate` from the loaded module) returns the expected
 *      clause ids on a fixture table — the policy that ships, not a copy
 *
 * Step 4 writes the plugin's module-private one-shot latch (a Set of agent ids).
 * Two things constrain it. First, the agent id MUST be a live root session id: the
 * handler classifies any id absent from `agents.roots()` as a subagent and skips it,
 * so a synthetic id can never gate and would prove nothing. Second, the restore is by
 * identity, not by value — the probe snapshots WHICH Set objects hold the key before
 * the call, deletes it only from Sets that newly gained it, then re-scans to prove
 * nothing holds it. Session ids appear in unrelated Sets too, so a delete-by-value
 * scan would corrupt live session bookkeeping. Residual risk, stated: for the few
 * milliseconds the key is set, a real turn in that session would miss its offer; the
 * key is removed before the probe exits, so the session keeps its one chance.
 *
 * Usage:
 *   node tools/live_probe.mjs                 # live check
 *   node tools/live_probe.mjs --self-check    # CI-safe: fixture-proves the verdict
 *   DSH_INSPECTOR_PORT=9230 node tools/live_probe.mjs
 *
 * Exit: 0 healthy · 1 loaded but broken · 2 host not running / Inspector unreachable
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.DSH_INSPECTOR_PORT ?? 9230);
const RUNNING = join(homedir(), '.dsh', 'dsh-config-manager', 'running', 'desktop.json');

// Two different strings on purpose: the loader row / fiber is named after the npm
// package, but the instruction it injects is stamped `source.kind = 'depth-elevation'`
// (lib/index.js). Comparing one against the other reports a working gate as missing.
const PLUGIN = 'dsh-depth-elevation';
const SOURCE_KIND = 'depth-elevation';
const GATE_MARK = '[depth-elevation gate]';
const ACTIVE = 2; // Cordis Fiber.state; every healthy plugin on this runtime carries it

/**
 * The live matcher must agree with this table. Each row is a prompt the rule text
 * decides one way: a clause fires, or the turn is exempt. A restart that silently
 * disables a clause — a wrong `verbs` array, a threshold reset to a default — shows
 * up here even though the plugin still "runs".
 *
 * Expectations are read off `lib/decide.js`, not off the ruler's own output:
 *  - clause (a) path/block/list are tested before any verb, so an inline list with a
 *    path is `a:path`, and a list only counts at `listMinChars` (40) or more;
 *  - verbs match in array order, so 把…整理成一份报告 is `b:报告` (报告 precedes 材料);
 *  - exemptions are length-capped at 30, so a short opener bypasses its prefix rule.
 */
const POLICY_FIXTURES = [
  ['帮我设计一套压力容器台账方案', 'b:设计'],
  ['分析这个表格数据', 'b:分析'],
  ['把这几份材料整理成一份报告', 'b:报告'],
  ['C:\\Users\\zzc\\Desktop\\清单.xlsx 看一下', 'a:path'],
  ['https://example.com/spec 读一下', 'c:link'],
  ['1. 甲方提供设备清单一份\n2. 乙方负责现场安装调试\n3. 双方共同验收签字确认', 'a:list'],
  ['- 甲方提供设备清单一份\n- 乙方负责现场安装调试\n- 双方共同验收签字确认', null],
  ['收到', null],
  ['已重启', null],
  ['继续', null],
];

/**
 * Pure verdict: live observations -> { ok, problems }.
 *
 * Separate from the CDP plumbing so `--self-check` can prove the judgement on
 * fixtures without a host. Each problem names the observation, not the symptom.
 */
export function analyse({ detail, seam, policy, latchLeft }) {
  const problems = [];
  if (!detail) return { ok: false, problems: ['no fiber detail returned'] };
  if (detail.fiberState !== ACTIVE) problems.push(`fiber state ${detail.fiberState}, expected ${ACTIVE} (ACTIVE)`);
  if (!detail.enabled) problems.push('plugin config is disabled');
  if (!detail.injectResolved) problems.push('declared agents service did not resolve');
  if (detail.preStepHandlers !== 1) problems.push(`${detail.preStepHandlers} pre-step handlers under the plugin ctx, expected 1`);
  if (!Array.isArray(policy)) problems.push('live matcher was never exercised');
  else {
    const wrong = policy.filter((row) => !row.ok);
    if (wrong.length) problems.push(`live matcher disagrees on ${wrong.length}/${policy.length} fixtures: ${wrong.map((r) => `${r.text}->${r.got}`).join('; ')}`);
  }
  if (!seam) problems.push('seam was never exercised');
  else {
    if (seam.gate?.kind !== 'enter') problems.push(`gated turn returned kind=${seam.gate?.kind}`);
    if (seam.gate?.source !== SOURCE_KIND) problems.push('substantive prompt was not gated');
    if (!seam.gate?.appended) problems.push('instruction was not appended to the batch');
    if (!String(seam.gate?.text ?? '').includes(GATE_MARK)) problems.push('instruction lacks the gate marker');
    if (!seam.gate?.preservedUserMessage) problems.push('handler dropped or replaced the user message');
    if (seam.exempt?.source !== null) problems.push('acknowledgment was gated (over-firing)');
  }
  if (latchLeft !== 0) problems.push(`latch restore left the probe key in ${latchLeft} set(s)`);
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Self-check: known-answer fixtures, runs anywhere (CI-safe, no host, no CDP)
// ---------------------------------------------------------------------------

const goodPolicy = POLICY_FIXTURES.map(([text, want]) => ({ text, want, got: want, ok: true }));
const goodDetail = { fiberState: 2, enabled: true, injectResolved: true, preStepHandlers: 1 };
const goodSeam = {
  gate: { kind: 'enter', source: SOURCE_KIND, appended: true, text: `${GATE_MARK} x (b:设计)`, preservedUserMessage: true },
  exempt: { source: null },
};
const clone = (value) => JSON.parse(JSON.stringify(value));

function selfCheck() {
  const cases = [
    ['healthy runtime -> ok', goodDetail, goodSeam, goodPolicy, 0, true],
    ['fiber not active -> fail', { ...goodDetail, fiberState: 0 }, goodSeam, goodPolicy, 0, false],
    ['config disabled -> fail', { ...goodDetail, enabled: false }, goodSeam, goodPolicy, 0, false],
    ['inject unresolved -> fail', { ...goodDetail, injectResolved: false }, goodSeam, goodPolicy, 0, false],
    ['no handler registered -> fail', { ...goodDetail, preStepHandlers: 0 }, goodSeam, goodPolicy, 0, false],
    ['duplicate handler -> fail', { ...goodDetail, preStepHandlers: 2 }, goodSeam, goodPolicy, 0, false],
    ['gate did not fire -> fail', goodDetail, { ...clone(goodSeam), gate: { ...goodSeam.gate, source: null } }, goodPolicy, 0, false],
    ['gate replaced the prompt -> fail', goodDetail, { ...clone(goodSeam), gate: { ...goodSeam.gate, preservedUserMessage: false } }, goodPolicy, 0, false],
    ['gate text lacks marker -> fail', goodDetail, { ...clone(goodSeam), gate: { ...goodSeam.gate, text: 'x' } }, goodPolicy, 0, false],
    ['acknowledgment gated -> fail', goodDetail, { ...clone(goodSeam), exempt: { source: SOURCE_KIND } }, goodPolicy, 0, false],
    ['latch not restored -> fail', goodDetail, goodSeam, goodPolicy, 1, false],
    ['no observations -> fail', null, null, null, 0, false],
    ['matcher drift -> fail', goodDetail, goodSeam, [{ text: '收到', want: null, got: 'b:设计', ok: false }], 0, false],
  ];

  let failed = 0;
  for (const [label, detail, seam, policy, latchLeft, want] of cases) {
    const got = analyse({ detail, seam, policy, latchLeft });
    if (got.ok !== want) {
      console.log(`FAIL  self-check ${label}: got ok=${got.ok}, want ${want}`);
      failed += 1;
    } else {
      console.log(`ok    ${label}`);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Live check
// ---------------------------------------------------------------------------

const report = (payload, code) => {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
};

async function readRunningPid() {
  try {
    return JSON.parse(await readFile(RUNNING, 'utf8')).pid ?? null;
  } catch {
    return null;
  }
}

async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch (error) {
    return { error: 'inspector-unreachable', detail: String(error.message).slice(0, 160), port: PORT };
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page?.webSocketDebuggerUrl) return { error: 'inspector-unreachable', port: PORT, targets: targets?.length ?? 0 };

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    pending.get(msg.id)(msg.result ?? { error: msg.error });
    pending.delete(msg.id);
  });
  const opened = await new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true), { once: true });
    ws.addEventListener('error', () => resolve(false), { once: true });
  });
  if (!opened) return { error: 'inspector-unreachable', port: PORT };

  const call = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  /** Evaluate an async IIFE body in the Host realm; returns its value by value. */
  const evaluate = async (body) => {
    const out = await call('Runtime.evaluate', {
      expression: `(async () => ${body})()`, awaitPromise: true, returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'evaluate failed');
    }
    return out.result?.value;
  };
  return { ws, call, evaluate };
}

// Shared prelude for every page expression: locate the live plugin fiber, the
// handler it registered, and its loaded module namespace. Reads are wrapped because
// a cordis Fiber whose context lacks `inject` throws on property access, and the
// inspector's retained set contains such fibers.
const PRELUDE = `
  const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
  const key = Symbol.for('dsh.inspector.realm-object-registries');
  const registry = [...(globalThis[key] ?? new Map()).values()][0];
  const fiberName = (f) => safe(() => f.entry?.options?.name ?? f.entry?.moduleNamespace?.name, '?');
  const fiber = [...(registry?.retained?.values() ?? [])].find(
    (o) => safe(() => o?.constructor?.name === 'Fiber', false) && fiberName(o) === ${JSON.stringify(PLUGIN)});
  const hook = fiber && (safe(() => fiber.ctx.events?._hooks?.['agent/pre-step'], []) ?? [])
    .find((h) => safe(() => h.ctx === fiber.ctx, false));
  const ns = fiber?.entry?.moduleNamespace;
`;

if (process.argv.includes('--self-check')) {
  const failed = selfCheck();
  console.log();
  if (failed) {
    console.log(`${failed} self-check case(s) failed`);
    process.exit(1);
  }
  console.log('self-check passed: the verdict function points the right way on 13 fixtures');
  process.exit(0);
}

const runningPid = await readRunningPid();
const runtime = await connect();
if (runtime.error) {
  report({
    ok: false,
    reason: runtime.error,
    port: PORT,
    runningPid,
    hint: `no CDP target on 127.0.0.1:${PORT}; is the Host running with the Inspector enabled?`,
  }, 2);
}

// --- 1-3. wiring, read-only ------------------------------------------------
let detail;
try {
  const raw = await runtime.evaluate(`{
    ${PRELUDE}
    if (!registry) return JSON.stringify({ error: 'no realm object registry — Inspector mounted?' });
    if (!fiber) return JSON.stringify({ error: 'fiber not found' });
    return JSON.stringify({
      fiberState: safe(() => fiber.state, null),
      enabled: safe(() => fiber.config?.enabled === true, false),
      // \`inject\` is only the declaration (values stay null for a plain required
      // service); resolution is visible in \`store\`, which cordis fills once every
      // declared service is present.
      injectResolved: safe(() => Object.keys(fiber.store ?? {}).includes('agents'), false),
      preStepHandlers: safe(() => (fiber.ctx.events?._hooks?.['agent/pre-step'] ?? []).filter((h) => h.ctx === fiber.ctx).length, 0),
      roots: safe(() => fiber.ctx.agents?.roots?.().map((r) => r.id), []),
    });
  }`);
  detail = JSON.parse(raw);
} catch (error) {
  runtime.ws.close();
  report({ ok: false, reason: 'evaluate-failed', port: PORT, runningPid, detail: String(error.message).slice(0, 300) }, 1);
}
if (detail.error) {
  runtime.ws.close();
  report({ ok: false, reason: 'not-loaded', port: PORT, runningPid, detail: detail.error }, 1);
}

// --- 5. live matcher (pure; no state touched) ------------------------------
let policy;
try {
  const raw = await runtime.evaluate(`{
    ${PRELUDE}
    if (!ns || typeof ns.decideGate !== 'function') return JSON.stringify({ error: 'decideGate not exported by the loaded module' });
    const fixtures = ${JSON.stringify(POLICY_FIXTURES)};
    const cfg = safe(() => fiber.config, {}) ?? {};
    const resolved = {
      enabled: cfg.enabled ?? true, verbs: cfg.verbs ?? [], exemptPrefix: cfg.exemptPrefix ?? [],
      minChars: cfg.minChars ?? 6, listMinChars: cfg.listMinChars ?? 40,
      materialMinChars: cfg.materialMinChars ?? 150, deliverableMinChars: cfg.deliverableMinChars ?? 20,
    };
    return JSON.stringify(fixtures.map(([text, want]) => {
      const batch = [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }];
      const got = safe(() => ns.decideGate(batch, { delegationDepth: 0, alreadyAsked: false }, resolved), 'threw');
      return { text, want, got, ok: got === want };
    }));
  }`);
  policy = JSON.parse(raw);
  if (policy.error) throw new Error(policy.error);
} catch (error) {
  runtime.ws.close();
  report({ ok: false, reason: 'matcher-unavailable', port: PORT, runningPid, detail: String(error.message).slice(0, 300) }, 1);
}

// --- 4. seam proof with an identity-exact restore ---------------------------
// The latch is a module-private Set. CDP can enumerate every Set object, so the
// probe records WHICH of them hold the candidate key before the call and deletes
// the key only from the ones that newly gained it. Deleting by value would also
// strip the id from unrelated Sets that legitimately hold it.
const setProto = await runtime.call('Runtime.evaluate', { expression: 'Set.prototype' });
const setHeap = await runtime.call('Runtime.queryObjects', { prototypeObjectId: setProto.result.objectId });
if (!setHeap.objects?.objectId) {
  runtime.ws.close();
  report({ ok: false, reason: 'inspector-query-failed', port: PORT, runningPid, detail: setHeap }, 1);
}
const setHeapId = setHeap.objects.objectId;

/** Indices (within the stable queryObjects array) of Sets that currently hold `id`. */
const holders = async (id) => JSON.parse((await runtime.call('Runtime.callFunctionOn', {
  objectId: setHeapId,
  functionDeclaration: `function (id) {
    return JSON.stringify([...this].reduce((acc, s, index) => {
      let v; try { v = [...s]; } catch { return acc; }
      if (v.includes(id)) acc.push(index);
      return acc;
    }, []));
  }`,
  arguments: [{ value: id }],
  returnByValue: true,
})).result.value);

const deleteFrom = async (indices, id) => runtime.call('Runtime.callFunctionOn', {
  objectId: setHeapId,
  functionDeclaration: `function (id, indices) {
    const sets = [...this];
    for (const index of indices) { try { sets[index].delete(id); } catch {} }
    return true;
  }`,
  arguments: [{ value: id }, { value: indices }],
  returnByValue: true,
});

const roots = detail.roots ?? [];
if (!roots.length) {
  runtime.ws.close();
  report({
    ok: false, reason: 'no-root-session', port: PORT, runningPid, detail,
    hint: 'open a session once so the runtime has an agent, then rerun',
  }, 1);
}

const send = async (agentId, text) => JSON.parse(await runtime.evaluate(`{
  ${PRELUDE}
  const messages = [{ source: { kind: 'user' }, content: [{ type: 'text', text: ${JSON.stringify(text)} }] }];
  const out = await hook.callback({ agent: { id: ${JSON.stringify(agentId)} }, messages },
    async () => ({ kind: 'enter', messages }));
  const injected = out.messages.filter((m) => m.source?.kind === ${JSON.stringify(SOURCE_KIND)});
  return JSON.stringify({
    kind: out.kind,
    appended: out.messages.length > messages.length,
    source: injected[0]?.source?.kind ?? null,
    text: String(injected[0]?.content?.[0]?.text ?? ''),
    preservedUserMessage: out.messages[0] === messages[0],
  });
}`));

let seam = null;
let probeRoot = null;
let probeAddedTo = [];
for (const root of roots) {
  const before = await holders(root);
  const gated = await send(root, '帮我设计一套压力容器台账方案');
  const after = await holders(root);
  probeAddedTo = after.filter((index) => !before.includes(index));
  if (gated.source) {
    probeRoot = root;
    // `收到` must stay exempt. The latch is already set, so this second call proves
    // the exemption rather than the latch — same decision path either way.
    const exempt = await send(root, '收到');
    seam = { gate: gated, exempt };
    break;
  }
  // Not gated: this root's one-shot offer was already spent (or it is not a root).
  // Put back anything the call could have touched; nothing should be there.
  if (probeAddedTo.length) await deleteFrom(probeAddedTo, root);
}

const latchLeft = probeRoot ? (await holders(probeRoot)).length : 0;
if (probeRoot && latchLeft) await deleteFrom(await holders(probeRoot), probeRoot);
const latchRestored = probeRoot ? (await holders(probeRoot)).length === 0 : true;

runtime.ws.close();

if (!seam) {
  report({
    ok: false,
    reason: 'all-roots-latched',
    port: PORT,
    runningPid,
    detail: { roots: roots.length, checks: { fiberState: detail.fiberState, enabled: detail.enabled,
      injectResolved: detail.injectResolved, preStepHandlers: detail.preStepHandlers,
      matcher: `${policy.filter((r) => r.ok).length}/${policy.length}` } },
    hint: 'every open session already used its one-turn offer; the wiring and matcher above still passed. '
      + 'Send one substantive prompt in a new session, then rerun to exercise the seam.',
  }, 1);
}

const problems = analyse({ detail, seam, policy, latchLeft: probeRoot ? (latchRestored ? 0 : 1) : 0 }).problems;
report({
  ok: problems.length === 0,
  pid: runningPid,
  port: PORT,
  fiberState: detail.fiberState,
  enabled: detail.enabled,
  injectResolved: detail.injectResolved,
  preStepHandlers: detail.preStepHandlers,
  roots: roots.length,
  matcher: `${policy.filter((r) => r.ok).length}/${policy.length} fixtures`,
  gatedClause: /\(([abc]:[^)]+)\)/.exec(seam.gate?.text ?? '')?.[1] ?? null,
  probeRoot,
  latchRestored,
  problems,
}, problems.length ? 1 : 0);
