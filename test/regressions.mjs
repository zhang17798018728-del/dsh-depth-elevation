#!/usr/bin/env node
/**
 * Regression checks for the claims this plugin makes about itself.
 *
 * Added after the 2026-10-21 audit: each of these failed against the shipped code
 * (see docs/AUDIT.md), and each is a behaviour the README promised.
 *
 * Each test asserts the behaviour the README claims, against the SHIPPING code.
 * Several of them FAIL today — that is the point: they are the executable form of
 * the audit findings, so the fixes can be verified instead of argued about.
 *
 *   node test/regressions.mjs
 *
 * Exit code 1 when any documented claim is violated.
 */

import { apply, Config } from '../lib/index.js';
import {
  DEFAULT_EXEMPT_PREFIX, DEFAULT_VERBS, instructionFor, matchClause,
} from '../lib/decide.js';

let failed = 0;
let passed = 0;
const check = (id, claim, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`ok    ${id}  ${claim}`); }
  else { failed += 1; console.log(`FAIL  ${id}  ${claim}${detail ? `\n        ${detail}` : ''}`); }
};

const CONFIG = {
  enabled: true, verbs: DEFAULT_VERBS,
  exemptPrefix: DEFAULT_EXEMPT_PREFIX, minChars: 6, listMinChars: 40,
  materialMinChars: 150, deliverableMinChars: 20,
};

// ---------------------------------------------------------------------------
// R1  matchClause must be linear-ish in input size (it runs on every step)
// ---------------------------------------------------------------------------
const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const small = '-a'.repeat(2_000);
const large = '-a'.repeat(8_000);          // 4x the input
const tSmall = time(() => matchClause(small, CONFIG));
const tLarge = time(() => matchClause(large, CONFIG));
const ratio = tLarge / Math.max(tSmall, 0.01);
check('R1', 'matchClause is linear in input size (4x input must cost ~4x, not 16x)',
  ratio < 8,
  `4x input cost ${ratio.toFixed(1)}x (${tSmall.toFixed(1)}ms -> ${tLarge.toFixed(1)}ms); quadratic backtracking in the a:path regex`);

// ---------------------------------------------------------------------------
// R2  a long path-like token must not be pathological
// ---------------------------------------------------------------------------
const bigToken = 'a-b'.repeat(30_000);     // 90k chars, one token, no dot
const tBig = time(() => matchClause(bigToken, CONFIG));
check('R2', 'a 90k-char single token stays under 100ms',
  tBig < 100,
  `took ${tBig.toFixed(0)}ms on ${bigToken.length} chars`);

// ---------------------------------------------------------------------------
// R3  exemptExact must be observable, or it is dead documentation
// ---------------------------------------------------------------------------
// With the shipped defaults every entry is <= minChars, so the length rule already
// excludes them: the knob cannot be observed by any input. Either delete the knob
// or give it a rule of its own; a config key nobody can observe is a lie in README.
const exported = Object.keys(await import('../lib/decide.js'));
check('R3', 'exemptExact is either observable or absent (not dead config)',
  !exported.includes('DEFAULT_EXEMPT_EXACT'),
  'DEFAULT_EXEMPT_EXACT is still exported although the length rule shadows every entry');

// ---------------------------------------------------------------------------
// R4  a follow-up prefix must not swallow a substantial new task
// ---------------------------------------------------------------------------
const newTask = '继续把刚才那套安全隐患台账的分析做成整改方案，并按单位汇总上报';
const sameTaskNoPrefix = '请把刚才那套安全隐患台账的分析做成整改方案，并按单位汇总上报';
check('R4', 'a substantial task is judged the same however it opens',
  (matchClause(newTask, CONFIG) !== null) === (matchClause(sameTaskNoPrefix, CONFIG) !== null),
  `"继续…" -> ${matchClause(newTask, CONFIG)} but "请…" -> ${matchClause(sameTaskNoPrefix, CONFIG)}`);

// ---------------------------------------------------------------------------
// R5  the gate must not fire on a message the human never wrote
// ---------------------------------------------------------------------------
function fakeCtx(rootIds = []) {
  const listeners = new Map();
  return { on(e, h) { listeners.set(e, h); return () => listeners.delete(e); }, listeners,
           // Contractual root registry: pre-step declares only Agent.id, so the
           // plugin must learn "is this a child?" from agents.roots(), never
           // from the incidental agent.session object.
           agents: { roots: () => rootIds.map((id) => ({ id })) },
           logger: { debug() {} } };
}
// Faithful fixture: the harness persists every message WITH its source kind, and the
// production listener now (correctly) requires a human-sourced message in the batch.
const um = (text, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } });
const ctx = fakeCtx(['r5', 'r5b']);
apply(ctx, new Config({}));
const run = (agent, messages) => ctx.listeners.get('agent/pre-step')(
  { agent, messages, signal: undefined },
  async () => ({ kind: 'enter', messages }));

const notice = 'background job pwsh-1 (pwsh: & "D:\\dsh资料\\cli.exe") started.';
const noticeRun = await run({ id: 'r5' }, [um(notice, 'tool-jobs')]);
check('R5', 'a non-human inbox notice does not gate',
  noticeRun.messages.length === 1,
  `a tool-jobs notice gated the turn; the human wrote nothing. 23 such notices exist locally.`);

const humanRun = await run({ id: 'r5b' }, [um('帮我设计一个工作台')]);
check('R5b', 'a real human prompt still gates',
  humanRun.messages.length === 2,
  `a user-sourced prompt produced ${humanRun.messages.length} messages, expected 2`);

// ---------------------------------------------------------------------------
// R6  the gate must not fire where a human cannot answer (subagent)
// ---------------------------------------------------------------------------
const subCtx = fakeCtx([]);   // empty roots: this agent is not a root
apply(subCtx, new Config({}));
const subAgent = { id: 'r6' };
const subRun = await subCtx.listeners.get('agent/pre-step')(
  { agent: subAgent, messages: [um('帮我设计一个工作台')], signal: undefined },
  async () => ({ kind: 'enter', messages: [um('帮我设计一个工作台')] }),
);
check('R6', 'a subagent session is not gated (harness: a live child cannot open a human interaction)',
  subRun.messages.length === 1,
  'the instruction demands ask_user_question, which fails with "human interaction is unavailable while the calling agent is owned by another live agent"');

// ---------------------------------------------------------------------------
// R7  dedupe must key on the session, not the Agent object
// ---------------------------------------------------------------------------
const dCtx = fakeCtx(['r7']);
apply(dCtx, new Config({}));
const dRun = (agent, text) => dCtx.listeners.get('agent/pre-step')(
  { agent, messages: [um(text)], signal: undefined },
  async () => ({ kind: 'enter', messages: [um(text)] }));
// A new Agent OBJECT but the same session id, exactly as resume() constructs one
// (the declared payload field `Agent.id` IS the SessionId).
const firstTurn = await dRun({ id: 'r7' }, '帮我设计一个工作台');
const resumed = await dRun({ id: 'r7' }, '再帮我优化这个方案');
check('R7', 'a resumed Agent on the same session is not re-gated',
  resumed.messages.length === 1,
  `first=${firstTurn.messages.length} messages, resumed=${resumed.messages.length}; observed 2 real re-gates (5ac69198, 7d4eeacf)`);

// ---------------------------------------------------------------------------
// R8  a rejected pre-step must not consume the session's only gate
// ---------------------------------------------------------------------------
// The prompt MUST be one that actually gates — `'帮我设计方案'` is exactly 6 chars,
// i.e. == minChars, so it never gates and the assertion would pass vacuously. That
// is the same trap as the dedupe assertion this audit already flagged.
const rCtx = fakeCtx(['r8']);
apply(rCtx, new Config({}));
const rAgent = { id: 'r8' };
const gateable = '帮我设计一个工作台';
const rej = await rCtx.listeners.get('agent/pre-step')(
  { agent: rAgent, messages: [um(gateable)], signal: undefined },
  async () => ({ kind: 'reject' }));
const retry = await rCtx.listeners.get('agent/pre-step')(
  { agent: rAgent, messages: [um(gateable)], signal: undefined },
  async () => ({ kind: 'enter', messages: [um(gateable)] }));
check('R8', 'a dropped turn stays recoverable (the README trade-off)',
  retry.messages.length > 1,
  `after ${rej.kind}, the same session produced ${retry.messages.length} message(s); asked.add() runs before next()`);

// ---------------------------------------------------------------------------
// R9  the exemption knob must be exercised by a prompt that needs it
// ---------------------------------------------------------------------------
const knobPrompt = '改成帮我分析这份台账并给出整改方案';
const knobOn = matchClause(knobPrompt, CONFIG);
const knobOff = matchClause(knobPrompt, { ...CONFIG, exemptPrefix: [] });
check('R9', 'exemptPrefix has an observable effect (knob is not decorative)',
  knobOn !== knobOff,
  `with=${knobOn} without=${knobOff}`);

// ---------------------------------------------------------------------------
// R10  a rejected downstream step must pass through untouched
// ---------------------------------------------------------------------------
check('R10', 'downstream reject passes through unchanged',
  rej.kind === 'reject',
  `got ${rej.kind}`);

// ---------------------------------------------------------------------------
// R11  the attached instruction names the rule that actually fired
// ---------------------------------------------------------------------------
// The model reads this text and obeys it. A constant claiming "hard trigger matched"
// was true for the b: clauses and a fiction for a path collision — and the model has
// no way to tell. Naming the clause is three characters and makes the claim honest.
const clauses = [...new Set([
  ...DEFAULT_VERBS.map((v) => `b:${v}`),
  'a:path', 'a:block', 'a:list', 'c:link', 'c:material', 'd:deliverable',
])];
const unnamed = clauses.filter((c) => !instructionFor(c).includes(c));
check('R11', 'every clause id appears in the instruction it produces',
  unnamed.length === 0,
  `these clauses are not named: ${unnamed.join(', ')}`);

// ---------------------------------------------------------------------------
// R12  the pre-step handler touches only contract-declared fields
// ---------------------------------------------------------------------------
// The declared payload is `Agent { id: SessionId }` — nothing else. Reading
// agent.session worked once only because the runtime handed over its internal
// object; a refactor there silently revives the resume and subagent bugs. This
// proxy fails loudly the moment any off-contract property is read.
const cCtx = fakeCtx(['r12']);
apply(cCtx, new Config({}));
const contractAgent = new Proxy({ id: 'r12' }, {
  get(target, prop) {
    if (prop !== 'id') throw new Error(`off-contract read: agent.${String(prop)}`);
    return target[prop];
  },
});
let contractError = null;
try {
  await cCtx.listeners.get('agent/pre-step')(
    { agent: contractAgent, messages: [um('帮我设计一个工作台')], signal: undefined },
    async () => ({ kind: 'enter', messages: [um('帮我设计一个工作台')] }));
} catch (e) { contractError = e; }
check('R12', 'pre-step handler reads only contract-declared Agent fields',
  contractError === null,
  contractError?.message ?? '');

// ---------------------------------------------------------------------------
// R13  the four-step method must name a checkable deliverable
// ---------------------------------------------------------------------------
// docs/RULE-SCIENCE.md 问题五: all three real 升维 cases recited the steps and
// skipped the rewrite — the steps had no observable artifact. Demanding the
// FULL rewritten prompt with ①-④ named makes compliance grep-able instead of
// self-declared.
const artifactParts = ['验收标准', '原始素材清单', '方法与工具', '外部裁判方式'];
const missingParts = artifactParts.filter((p) => !instructionFor('b:设计').includes(p));
check('R13', 'the instruction demands a rewritten-prompt artifact (four named parts)',
  missingParts.length === 0,
  `missing: ${missingParts.join(', ')}`);

console.log();
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nEvery FAIL above is a documented claim the shipping code does not meet.');
  process.exit(1);
}
console.log('all documented claims hold');
