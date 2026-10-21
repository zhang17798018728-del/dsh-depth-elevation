#!/usr/bin/env node
/**
 * End-to-end proof that the plugin gates a turn, without a model or network.
 *
 * The model call is the one part that cannot be made deterministic here (the
 * configured providers were rate-limited or out of credit while this was built).
 * Everything the model's behaviour depends on, though, is deterministic: the
 * messages handed to the next step either contain the elevation instruction or
 * they do not.
 *
 * So this drives the shipping `apply()` exactly as the harness does, and asserts
 * on the batch that would be sent — including that the context survives when
 * other listeners wrap the decision, which is how real profiles stack plugins.
 *
 *   node test/e2e.mjs
 */

import { apply, Config, INSTRUCTION } from '../lib/index.js';

let failed = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failed += 1;
};
const ok = (msg) => console.log(`PASS  ${msg}`);

function ctx() {
  const listeners = new Map();
  return {
    on(event, handler) {
      listeners.set(event, handler);
    },
    listeners,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

const text = (msg) => (msg.content ?? []).map((p) => p.text ?? '').join('');
const userMsg = (body, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text: body }], source: { kind } });

/**
 * A realistic batch: the harness prepends workspace context, the user's own
 * prompt, and a trailing system-reminder. The plugin must judge the human text
 * and append the instruction.
 */
const BATCH = [
  userMsg('<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\n\n# Ambition...\n</system-reminder>'),
  userMsg('帮我分析这份隐患台账并设计整改方案'),
  userMsg('<system-reminder>\nTime sampled: 2026-10-20T19:00:00+08:00\n</system-reminder>'),
];

const c = ctx();
apply(c, new Config({}));
const preStep = c.listeners.get('agent/pre-step');
if (!preStep) {
  fail('apply() did not register agent/pre-step');
  process.exit(1);
}

// Walk the seam the way the harness does: next() hands back the entering batch.
let downstreamBatch = null;
const next = async () => {
  downstreamBatch = BATCH;
  return { kind: 'enter', messages: BATCH };
};

const decision = await preStep({ agent: { id: 'e2e' }, messages: BATCH, signal: undefined }, next);

if (decision.kind !== 'enter') {
  fail(`decision was ${decision.kind}, expected enter (reject would drop the prompt)`);
} else {
  ok('returns enter (never reject)');
}

// The human prompt must survive untouched.
const bodies = decision.messages.map(text);
if (!bodies.includes('帮我分析这份隐患台账并设计整改方案')) {
  fail('user prompt missing from the batch');
} else {
  ok('user prompt preserved in the batch');
}

// The instruction must be present, verbatim, as its own message.
const instruction = decision.messages
  .map(text)
  .find((t) => t.includes('depth-elevation gate'));
if (!instruction) {
  fail('elevation instruction not appended to the batch');
} else if (instruction !== INSTRUCTION) {
  fail('appended instruction differs from the shipped INSTRUCTION constant');
} else {
  ok('elevation instruction appended verbatim');
}

// Provenance: the instruction must be attributable to the plugin, never to the user.
const ctxMessage = decision.messages.find((m) => text(m).includes('depth-elevation gate'));
if (ctxMessage?.source?.kind !== 'depth-elevation') {
  fail(`context message source is ${JSON.stringify(ctxMessage?.source)}, expected depth-elevation`);
} else {
  ok('context message carries depth-elevation provenance');
}

// Ordering: context goes after the user's prompt, so it reads as an instruction
// about the turn rather than as something the user said first.
const userIdx = decision.messages.findIndex((m) => text(m).includes('帮我分析这份隐患台账'));
const ctxIdx = decision.messages.findIndex((m) => text(m).includes('depth-elevation gate'));
if (ctxIdx <= userIdx) {
  fail(`context at index ${ctxIdx} must follow the user prompt at ${userIdx}`);
} else {
  ok('context follows the user prompt');
}

// Second turn in the same session: no repeat.
const again = await preStep(
  { agent: { id: 'e2e' }, messages: [userMsg('再帮我把整改变成表格')], signal: undefined },
  async () => ({ kind: 'enter', messages: [userMsg('再帮我把整改变成表格')] }),
);
if (again.messages.length !== 1) {
  fail('re-gated on the second turn of the same session');
} else {
  ok('second turn in the session is not gated');
}

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log('PASS: end-to-end turn gating verified (no model required)');
