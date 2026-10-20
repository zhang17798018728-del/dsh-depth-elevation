/**
 * Pure decision core for the depth-elevation gate.
 *
 * Everything here is a pure function of (text, config): no I/O, no clock, no
 * process state. That is deliberate — the verifier runs this exact module
 * against 62 real historical turns, so the thing being tested is the thing that
 * ships, not a reimplementation of it.
 *
 * @module dsh-depth-elevation/decide
 */

/** Default trigger verbs — the (b) clause of AGENTS.md §5. */
export const DEFAULT_VERBS = [
  // original wording
  '设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构',
  '排查', '评估', '报告', '课件', '教学',
  // added after replaying real history: these were silently skipped
  '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化', '诊断', '材料',
  // build/creation verbs — found missed by the replay's passed-through list
  '创建', '开发', '实现', '做一个', '写成', '整成',
];

/** Turns that never gate, however long they are. */
export const DEFAULT_EXEMPT_EXACT = ['继续', '好', '是', '可以', '行', 'ok', 'OK', '嗯', '对', 'a', '1'];

/** Follow-up edits that begin with these stay exempt. */
export const DEFAULT_EXEMPT_PREFIX = ['改成', '换成', '再来', '继续', '接着', '然后', '好的', '收到'];

/** A prompt containing this already carries an offer; never gate it again. */
export const OFFER_MARK = '顶尖专家深度与野心';

/**
 * The instruction attached to a gated turn.
 *
 * Kept as one exported constant so the verifier can assert that every part the
 * model needs (tool name, question text, option labels) is actually present.
 */
export const INSTRUCTION = [
  '[depth-elevation gate] AGENTS.md §5 hard trigger matched. Your FIRST action this',
  'turn must be ask_user_question, before any file read, search, or write:',
  '  id: elevation, header: 深度',
  '  question: 💡 检测到该任务具备深挖潜力，是否需要按【顶尖专家深度与野心】重构此任务？',
  '            （将先梳理：①顶级专家未想之策 ②原始底层素材 ③专业工具与模型 ④客观外部裁判标准，重写提示词后再执行）',
  '  options: 升维：按专家级做（推荐） / 直接做：先出能用的版本',
  'Do not decide the task is trivial and skip it; that call belongs to the user.',
].join('\n');

/** Strip harness-injected context so only the human's own words are judged. */
export function humanText(prompt) {
  return String(prompt ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<hindsight_knowledge_refresh>[\s\S]*?<\/hindsight_knowledge_refresh>/g, '')
    .replace(/<hindsight_knowledge>[\s\S]*?<\/hindsight_knowledge>/g, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/g, '')
    .trim();
}

/**
 * Decide whether a prompt must be gated.
 *
 * @param text - already-normalized prompt text (see {@link humanText}).
 * @param config - resolved plugin config.
 * @returns the matched rule clause id, or null when the turn stays exempt.
 */
export function matchClause(text, config) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (!config.enabled) return null;
  if (t.includes(OFFER_MARK)) return null;                       // already offered
  if (config.exemptExact.includes(t)) return null;               // "继续", "是", ...
  if (config.exemptPrefix.some((p) => t.startsWith(p))) return null;
  if (t.length <= config.minChars) return null;                  // single-point query

  if (/https?:\/\//.test(t)) return 'c:link';                    // (c) link material
  if (/[A-Za-z]:\\|\b[\w-]+\.(py|md|xlsx|docx|json|html|ts|js|csv)\b/.test(t)) return 'a:path';
  if (t.includes('```') || t.includes('\t') || (t.match(/\|/g) || []).length >= 4) return 'a:block';
  if (/^\s*(\d+[.、)]|[-*]\s)/m.test(t) && t.length >= config.listMinChars) return 'a:list';

  const verb = config.verbs.find((v) => t.includes(v));
  if (verb) return `b:${verb}`;                                  // (b) trigger verb

  if (t.length >= config.materialMinChars) return 'c:material';  // (c) pasted material
  if (/(给我|帮我|生成|输出|整理成|做成)/.test(t) && t.length >= config.deliverableMinChars) {
    return 'd:deliverable';
  }
  return null;
}
