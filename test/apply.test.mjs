#!/usr/bin/env node
/**
 * Integration test for the plugin's `apply()` — the part a pure-function test
 * cannot cover.
 *
 * The decision core is tested against real history elsewhere. This test covers
 * the wiring: does `apply()` register on `agent/pre-step`, does it append a
 * sourced context message to the entering batch, does it stay silent on the
 * second turn of a session, and does it ever return `reject` (which would drop
 * the user's prompt)?
 *
 * Runs the shipping `apply()` with a minimal fake Cordis context — no harness,
 * no model, no network.
 *
 *   node test/apply.test.mjs
 */

import { apply, Config } from '../lib/index.js';

let failed = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failed += 1;
};

/** Minimal Cordis context: captures the registered listener. */
function fakeCtx() {
  const listeners = new Map();
  return {
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    listeners,
    logger: { debug() {}, warn() {}, info() {} },
  };
}

/** A user message as the harness would hand it to pre-step. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** Run one turn through the registered pre-step listener. */
async function turn(ctx, text, agent, downstream = 'enter') {
  const preStep = ctx.listeners.get('agent/pre-step');
  if (!preStep) throw new Error('plugin did not register agent/pre-step');
  const next = async () => (downstream === 'enter'
    ? { kind: 'enter', messages: [userMessage(text)] }
    : { kind: 'reject' });
  return preStep({ agent, messages: [userMessage(text)], signal: undefined }, next);
}

const config = new Config({});
const ctx = fakeCtx();
apply(ctx, config);

// 1. registered the seam
if (!ctx.listeners.has('agent/pre-step')) fail('did not register agent/pre-step');
else console.log('PASS  registers agent/pre-step');

// 2. substantive turn gets a sourced context appended
const agentA = { id: 'session-a' };
const first = await turn(ctx, '帮我分析这份隐患台账并设计整改方案', agentA);
if (first.kind !== 'enter') {
  fail(`returned ${first.kind} — must be enter, reject would drop the user prompt`);
} else if (first.messages.length !== 2) {
  fail(`expected 2 messages (user + context), got ${first.messages.length}`);
} else {
  const context = first.messages[1];
  const text = context.content.map((p) => p.text).join('');
  if (context.source?.kind !== 'depth-elevation') fail('context message lacks source attribution');
  else if (!text.includes('ask_user_question') || !text.includes('顶尖专家深度与野心')) {
    fail('context message does not carry the elevation instruction');
  } else {
    console.log('PASS  substantive turn gets sourced elevation context');
  }
}

// 3. the user's own message is preserved verbatim (never dropped, never rewritten)
if (first.kind === 'enter') {
  const userText = first.messages[0].content.map((p) => p.text).join('');
  if (userText !== '帮我分析这份隐患台账并设计整改方案') fail('user message was modified or replaced');
  else console.log('PASS  user message preserved verbatim');
}

// 4. follow-up in the same session is not gated again
const second = await turn(ctx, '再帮我把整改变成表格', agentA);
if (second.kind === 'enter' && second.messages.length !== 1) {
  fail(`re-gated within one session (${second.messages.length} messages)`);
} else {
  console.log('PASS  one gate per session');
}

// 5. a different session is gated independently
const agentB = { id: 'session-b' };
const third = await turn(ctx, '帮我设计一个安全巡检流程', agentB);
if (third.kind !== 'enter' || third.messages.length !== 2) {
  fail('second session was not gated');
} else {
  console.log('PASS  each session gated independently');
}

// 6. an ack is never gated
const acks = ['继续', '好', '改成第三项', '完成了吗？给我看看预览版'];
for (const ack of acks) {
  const r = await turn(ctx, ack, { id: `session-ack-${ack}` });
  if (r.kind !== 'enter' || r.messages.length !== 1) fail(`ack ${JSON.stringify(ack)} was gated`);
}
console.log(`PASS  ${acks.length} acks stay exempt`);

// 7. a downstream reject is passed through untouched (no context added to a rejected step)
const rejected = await turn(ctx, '帮我设计一个工作台', { id: 'session-reject' }, 'reject');
if (rejected.kind !== 'reject') fail('downstream reject was not passed through');
else console.log('PASS  downstream reject passes through untouched');

// 8. enabled=false disables without unmounting
const offCtx = fakeCtx();
apply(offCtx, new Config({ enabled: false }));
const off = await turn(offCtx, '帮我分析这份台账并设计方案', { id: 'session-off' });
if (off.kind !== 'enter' || off.messages.length !== 1) fail('enabled=false still gated');
else console.log('PASS  enabled=false disables the gate');

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log('PASS: apply() wires the seam, preserves the prompt, and gates once per session');
