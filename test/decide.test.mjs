#!/usr/bin/env node
/**
 * Verifier for dsh-depth-elevation's decision core.
 *
 * Two layers:
 *   1. curated cases — the behaviours that must hold (gate real work, exempt acks,
 *      one ask per session, instruction completeness)
 *   2. history replay — every real user turn since the rule was installed, run
 *      through the shipping matcher. This is the only sample not chosen by the
 *      person who wrote the rules, so it is the one that catches over/under-firing.
 *
 * No framework, no fixtures: a failure is an exit code.
 *
 *   node test/decide.test.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_EXEMPT_EXACT,
  DEFAULT_EXEMPT_PREFIX,
  DEFAULT_VERBS,
  INSTRUCTION,
  humanText,
  matchClause,
} from '../lib/decide.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = {
  enabled: true,
  verbs: DEFAULT_VERBS,
  exemptExact: DEFAULT_EXEMPT_EXACT,
  exemptPrefix: DEFAULT_EXEMPT_PREFIX,
  minChars: 6,
  listMinChars: 40,
  materialMinChars: 150,
  deliverableMinChars: 20,
};

let failed = 0;
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  failed += 1;
};

// ---------------------------------------------------------------------------
// 1. Curated cases
// ---------------------------------------------------------------------------

const CASES = [
  // must GATE
  ['我是一名选煤厂安全员，工作内容基本固定，可以帮我设计一个工作台吗，先设计思路', true, 'design task'],
  ['帮我分析一下这份隐患台账的数据', true, 'analyse'],
  ['@H:\\wechat\\file\\硬措施落实责任清单.xlsx 承包商管理必查必究', true, 'file path'],
  ['https://mp.weixin.qq.com/s/abc 根据这篇文章的核心观点，我现有的 skills 有何不足', true, 'link material'],
  ['存在问题\t整改措施\n主洗二楼管道杂物未清理。\t及时清理。', true, 'pasted table'],
  ['我现在要写10月的汇报材料，先复制一份9月的，10月份的内容逐项问我进行填充', true, 'monthly report (was skipped)'],
  ['冬季四防排查／月度培训《消防安全基础》／加强车辆管理/三违查处', true, 'planning list'],
  ['安全管理制度要求各岗位人员严格执行操作规程、定期检查设备设施、如实记录运行参数、发现异常立即上报并采取措施。请据此梳理本岗位的风险点。', true, 'long material'],
  // must PASS
  ['继续', false, 'ack'],
  ['好', false, 'ack'],
  ['是', false, 'ack'],
  ['a', false, 'ack single char'],
  ['改成第三项', false, 'follow-up edit'],
  ['完成了吗？给我看看预览版', false, 'status check'],
  ['总结本次最终提示词发我', false, 'recap request'],
  ['中文', false, 'one word'],
  ['怎么个流程，接到任务之后', false, 'short question'],
  ['💡 检测到该任务具备深挖潜力。请按【顶尖专家深度与野心】重构 这个设计任务，①顶级专家未想之策', false, 'already offered'],
];

for (const [prompt, expectGate, label] of CASES) {
  const clause = matchClause(humanText(prompt), CONFIG);
  const gated = clause !== null;
  if (gated !== expectGate) {
    fail(`${label}: expected ${expectGate ? 'GATE' : 'pass'}, got ${gated ? `GATE (${clause})` : 'pass'}`);
  }
}
console.log(`${CASES.length} curated cases checked`);

// The instruction must carry everything the model needs to comply.
for (const must of ['ask_user_question', '顶尖专家深度与野心', 'elevation', '升维', 'FIRST action']) {
  if (!INSTRUCTION.includes(must)) fail(`INSTRUCTION missing ${JSON.stringify(must)}`);
}

// Config must actually change behaviour, or the knobs are decorative.
const offConfig = { ...CONFIG, enabled: false };
if (matchClause('帮我设计一个工作台', offConfig) !== null) fail('enabled=false does not disable the gate');
const narrowConfig = { ...CONFIG, verbs: ['量子'] };
if (matchClause('帮我设计一个工作台', narrowConfig) !== null) fail('custom verbs list is ignored');
const wideConfig = { ...CONFIG, exemptExact: [] };
if (matchClause('继续', wideConfig) !== null) fail('emptying exemptExact does not re-enable gating');
console.log('config knobs verified (enabled / verbs / exemptExact)');

// ---------------------------------------------------------------------------
// 2. History replay
// ---------------------------------------------------------------------------

const SESSIONS = join(homedir(), '.dsh', 'sessions');
const SINCE = Date.UTC(2026, 9, 19, 5, 40);   // 2026-10-19 13:40 +08:00, rule installed
const NOISE = ['hindsight_knowledge', 'Current runtime context', 'Time sampled',
  'The approval policy', 'The working directory', '[advisor', '[model changed',
  'Background subagent', 'Agent ', '<system-reminder'];

/** True when a local session corpus exists (the CI runner has none). */
function sessionCorpusExists() {
  const root = join(homedir(), '.dsh', 'sessions');
  return existsSync(root) && statSync(root).isDirectory()
    && readdirSync(root).some((d) => statSync(join(root, d)).isDirectory());
}

/**
 * Decode user turns via Python: the transcripts are multi-frame zstd, which
 * Node's zlib cannot read past the first frame.
 *
 * Returns an empty array when there is no corpus at all — that is the CI case,
 * not a failure. A corpus that exists but cannot be decoded still throws,
 * because silently losing the replay would turn the strongest evidence into a
 * no-op.
 */
function realTurns() {
  if (!sessionCorpusExists()) return [];
  const script = join(HERE, '_dump_turns.py');
  const out = execFileSync('python', [script], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const rows = JSON.parse(out);
  return rows
    .filter((r) => r.at >= SINCE)
    // Drop this plugin's own injected instructions: they are test artifacts
    // replayed back as user turns, not something a human typed.
    .filter((r) => !r.body.startsWith('[depth-elevation gate]'))
    .filter((r) => r.body && !NOISE.some((n) => r.body.startsWith(n)));
}

let turns = [];
try {
  turns = realTurns() ?? [];
  if (turns.length === 0 && !sessionCorpusExists()) {
    console.log('history replay: skipped (no local dsh session corpus on this machine)');
  } else if (turns.length === 0) {
    // Corpus present but it yielded nothing: that is a broken replay, not a skip.
    fail('history replay: session corpus exists but produced zero turns');
  }
} catch (error) {
  // A corpus that exists must replay: a skipped layer must never read as a pass.
  fail(`history replay unavailable: ${String(error.message).slice(0, 200)}`);
}

if (turns.length > 0) {
  const substantive = turns.filter((t) => t.body.length >= 20);
  const gated = substantive.filter((t) => matchClause(t.body, CONFIG) !== null);
  const pct = substantive.length ? Math.round((100 * gated.length) / substantive.length) : 0;
  console.log(`history replay: ${turns.length} turns, ${substantive.length} substantive, ${gated.length} gated (${pct}%)`);

  const sessionsWithSub = new Set(substantive.map((t) => t.sid));
  const sessionsGated = new Set(gated.map((t) => t.sid));
  console.log(`  sessions: ${sessionsWithSub.size} with substantive work, ${sessionsGated.size} gated`);

  const passed = turns.filter((t) => matchClause(t.body, CONFIG) === null);
  for (const t of passed) {
    console.log(`  pass  ${String(t.body.length).padStart(4)}ch  ${t.body.replace(/\s+/g, ' ').slice(0, 76)}`);
  }

  if (substantive.length < 20) fail(`history sample too small (${substantive.length})`);
  if (gated.length === 0) fail('never gates real history');
  if (substantive.length && gated.length / substantive.length > 0.85) {
    fail(`gates ${pct}% of substantive turns — not discriminating`);
  }
  // The two sessions whose only work was a single-point question must stay exempt.
  const misses = [...sessionsWithSub].filter((s) => !sessionsGated.has(s));
  if (misses.length > sessionsWithSub.size / 2) fail(`missed ${misses.length}/${sessionsWithSub.size} sessions`);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
console.log('PASS: matcher gates substantive work, exempts acks, and honours config');
