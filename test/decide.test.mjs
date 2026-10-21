#!/usr/bin/env node
/**
 * Verifier for dsh-depth-elevation's decision core.
 *
 * Three layers:
 *   1. curated cases — the behaviours that must hold (gate real work, exempt acks,
 *      instruction completeness)
 *   2. history replay — every real claimed batch since the rule was installed, run
 *      through the SHIPPING decision. This is the only sample not chosen by the
 *      person who wrote the rules, so it is the one that catches over/under-firing.
 *   3. truth check — the replay's verdict is compared against what actually happened
 *      on disk (did a gate fire on this batch?). A replay that reproduces real
 *      behaviour is evidence; one that merely produces plausible numbers is not.
 *
 * The replay input is the claimed inbox batch, because that is what `preStep` passes
 * to the plugin — see test/_dump_claims.py for the reconstruction and its proof.
 *
 * No framework, no fixtures: a failure is an exit code.
 *
 *   node test/decide.test.mjs
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  DEFAULT_EXEMPT_PREFIX,
  DEFAULT_VERBS,
  INSTRUCTION,
  decideGate,
} from '../lib/decide.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = {
  enabled: true,
  verbs: DEFAULT_VERBS,
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

/** A claimed batch as the harness builds it: [{role, content, source}]. */
const batch = (text, kind = 'user') => [
  { role: 'user', content: [{ type: 'text', text }], source: { kind } },
];
const gate = (text, kind, context) => decideGate(batch(text, kind), context, CONFIG);

// ---------------------------------------------------------------------------
// 1. Curated cases
// ---------------------------------------------------------------------------

const CASES = [
  // must GATE — real substantive work
  ['我是一名选煤厂安全员，工作内容基本固定，可以帮我设计一个工作台吗，先设计思路', true, 'design task'],
  ['帮我分析一下这份隐患台账的数据', true, 'analyse'],
  ['@H:\\wechat\\file\\硬措施落实责任清单.xlsx 承包商管理必查必究', true, 'file path'],
  ['https://mp.weixin.qq.com/s/abc 根据这篇文章的核心观点，我现有的 skills 有何不足', true, 'link material'],
  ['存在问题\t整改措施\n主洗二楼管道杂物未清理。\t及时清理。', true, 'pasted table'],
  ['我现在要写10月的汇报材料，先复制一份9月的，10月份的内容逐项问我进行填充', true, 'monthly report'],
  ['冬季四防排查／月度培训《消防安全基础》／加强车辆管理/三违查处', true, 'planning list'],
  ['安全管理制度要求各岗位人员严格执行操作规程、定期检查设备设施、如实记录运行参数、发现异常立即上报并采取措施。请据此梳理本岗位的风险点。', true, 'long material'],
  // must PASS — single-point, acks, follow-ups
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
  const clause = gate(prompt, 'user');
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

// ---------------------------------------------------------------------------
// 2. Policy guards — the reasons a batch is skipped even when it would match
// ---------------------------------------------------------------------------

if (gate('帮我设计一个工作台', 'user', { delegationDepth: 1 }) !== null) {
  fail('a subagent batch gated (harness refuses human interaction from a live child)');
}
if (gate('帮我设计一个工作台', 'user', { alreadyAsked: true }) !== null) {
  fail('a batch gated twice in the same session');
}
for (const kind of ['tool-jobs', 'subagent-settled', 'agent-message', 'advisor',
  'user-approval', 'working-directory', 'repeat-tool-reminder', 'goal']) {
  if (gate('帮我分析这份隐患台账并设计整改方案', kind) !== null) {
    fail(`a ${kind} notice gated: the human wrote nothing, yet the offer fired`);
  }
}
// A human prompt mixed with harness notices still gates: the notices must not mask it.
const mixed = [
  { role: 'user', content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never".' }], source: { kind: 'user-approval' } },
  ...batch('帮我分析这份隐患台账并设计整改方案'),
];
if (decideGate(mixed, {}, CONFIG) === null) fail('a human prompt was masked by an adjacent notice');
console.log('policy guards checked (subagent / dedupe / 8 notice kinds / mixed batch)');

// ---------------------------------------------------------------------------
// 3. History replay on the claimed batch — the production input
// ---------------------------------------------------------------------------

const SESSIONS = join(homedir(), '.dsh', 'sessions');

/** True when a local session corpus exists (the CI runner has none). */
function sessionCorpusExists() {
  return existsSync(SESSIONS) && statSync(SESSIONS).isDirectory()
    && readdirSync(SESSIONS).some((d) => statSync(join(SESSIONS, d)).isDirectory());
}

/**
 * Decode the claimed batches via Python: the transcripts are multi-frame zstd,
 * which Node's zlib cannot read past the first frame.
 *
 * Returns an empty array when there is no corpus at all — that is the CI case,
 * not a failure. A corpus that exists but cannot be decoded still throws,
 * because silently losing the replay would turn the strongest evidence into a
 * no-op.
 */
function claimedBatches() {
  if (!sessionCorpusExists()) return [];
  const out = execFileSync('python', [join(HERE, '_dump_claims.py')],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  return JSON.parse(out);
}

let rows = [];
try {
  rows = claimedBatches() ?? [];
  if (rows.length === 0 && !sessionCorpusExists()) {
    console.log('history replay: skipped (no local dsh session corpus on this machine)');
  } else if (rows.length === 0) {
    fail('history replay: session corpus exists but produced zero claimed batches');
  }
} catch (error) {
  fail(`history replay unavailable: ${String(error.message).slice(0, 200)}`);
}

if (rows.length > 0) {
  let gatedNow = 0;
  let firedBefore = 0;
  let agreed = 0;
  let fixedByDedupe = 0;
  let fixedByGuard = 0;
  const overFires = [];
  const misses = [];
  const gatedSessions = new Set();

  for (const row of rows) {
    // Replay the shipping policy, including the one-shot latch: once a session's
    // batch gates, later batches in the same session must not gate again.
    const alreadyAsked = gatedSessions.has(row.sid);
    const clause = decideGate(row.messages, {
      delegationDepth: row.depth,
      alreadyAsked,
    }, CONFIG);
    const gateNow = clause !== null;
    if (gateNow) {
      gatedNow += 1;
      gatedSessions.add(row.sid);
    }
    if (row.fired) firedBefore += 1;

    if (gateNow === row.fired) {
      agreed += 1;
      continue;
    }
    if (!gateNow && row.fired) {
      // A real fire the shipped policy now skips. Two causes, both fixes, not misses:
      //  - the batch is a subagent or non-human notice (guard added by this audit)
      //  - a duplicate offer in a session that already gated (dedupe keyed on the
      //    Agent object re-fired after a resume; now keyed on the session)
      const nonHuman = row.depth > 0
        || !row.messages.some((m) => m.source?.kind === 'user');
      const wouldGate = decideGate(row.messages, { delegationDepth: row.depth }, CONFIG) !== null;
      if (nonHuman) fixedByGuard += 1;
      else if (wouldGate && alreadyAsked) fixedByDedupe += 1;
      else {
        misses.push(`${JSON.stringify(row.messages.map((m) => m.content[0]?.text ?? '').join(' ').slice(0, 84))}`);
      }
      continue;
    }
    overFires.push({ clause, row });
  }

  const total = rows.length;
  const pct = (n) => `${n} (${Math.round((100 * n) / total)}%)`;
  console.log(`history replay: ${total} claimed batches from ${new Set(rows.map((r) => r.sid)).size} sessions`);
  console.log(`  matcher gates now        : ${gatedNow}`);
  console.log(`  gates that really fired  : ${firedBefore}`);
  console.log(`  agreement                : ${pct(agreed)}`);
  console.log(`  explained (fixed guard)  : ${pct(fixedByGuard)}  <- subagent / non-human notice, now skipped`);
  console.log(`  explained (fixed dedupe) : ${pct(fixedByDedupe)}  <- duplicate offer after resume, now suppressed`);
  console.log(`  unexplained misses       : ${pct(misses.length)}`);

  for (const m of misses.slice(0, 6)) console.log(`  miss  ${m}`);

  // The corpus predates the plugin AND spans several workspaces. A batch can only be
  // counted against the plugin if the plugin was mounted for that session. Two filters,
  // both evidenced rather than assumed:
  //   - before the first real fire, nothing had fired yet by definition
  //   - a workspace with zero fires in the whole corpus never had the plugin mounted
  const firstFire = Math.min(...rows.filter((r) => r.fired).map((r) => r.at));
  const workspacesWithFires = new Set(rows.filter((r) => r.fired).map((r) => r.profile));
  const armed = (row) => row.at >= firstFire && workspacesWithFires.has(row.profile);
  const inEra = overFires.filter((o) => armed(o.row));
  const unarmed = overFires.length - inEra.length;
  console.log(`  over-fires               : ${pct(overFires.length)}`);
  console.log(`    not countable (before first fire or workspace never mounted): ${pct(unarmed)}`);
  console.log(`    in an armed workspace  : ${pct(inEra.length)}  <- the honest false-positive rate`);
  const eraByClause = new Map();
  for (const o of inEra) eraByClause.set(o.clause, (eraByClause.get(o.clause) ?? 0) + 1);
  if (eraByClause.size) {
    console.log(`    by clause: ${[...eraByClause].map(([k, v]) => `${k}x${v}`).join(', ')}`);
  }

  if (total < 100) fail(`history sample too small (${total} claimed batches)`);
  if (firedBefore === 0) fail('the corpus contains no real gate fires — the replay proves nothing');
  if (gatedNow === 0) fail('never gates real history');
  // Unchanged input must reproduce real behaviour. Divergence is only allowed when a
  // fix explains it, and every such case is counted above rather than silently dropped.
  if (misses.length > 0) {
    fail(`${misses.length} real fires are neither reproduced nor explained by a fix`);
  }
  // Over-firing is the failure mode users notice: an offer on every turn trains people
  // to ignore it. Bound it where the comparison is meaningful, not corpus-wide.
  const eraRate = Math.round((100 * inEra.length) / Math.max(total, 1));
  if (eraRate > 20) fail(`gates ${eraRate}% of armed batches as new offers — not discriminating`);
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const replayed = rows.length > 0;
console.log();
if (failed) {
  console.log(`${failed} FAILED`);
  process.exit(1);
}
// Never claim a layer that did not run: the CI runner has no session store, so the
// verdict says which proofs actually happened.
console.log(replayed
  ? 'PASS: matcher gates substantive work, exempts acks, honours config, and reproduces history'
  : 'PASS: matcher gates substantive work, exempts acks, honours config (history replay SKIPPED — no session corpus)');
