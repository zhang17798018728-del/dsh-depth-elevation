/**
 * Pure decision core for the depth-elevation gate.
 *
 * Everything here is a pure function of its arguments: no I/O, no clock, no process
 * state. That is deliberate — `test/decide.test.mjs` replays this exact module
 * against the claimed batches the harness really handed the plugin, so the thing
 * being tested is the thing that ships, not a reimplementation of it.
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

/**
 * Short follow-up openers that stay exempt.
 *
 * The length cap in {@link matchClause} is what makes this safe: without it,
 * "继续把整套整改方案重做成上报版" would be exempted by its first two characters.
 */
export const DEFAULT_EXEMPT_PREFIX = ['改成', '换成', '再来', '继续', '接着', '然后', '好的', '收到'];

/** A prompt containing this already carries an offer; never gate it again. */
export const OFFER_MARK = '顶尖专家深度与野心';

/**
 * The instruction attached to a gated turn.
 *
 * Kept as one exported builder so the verifier can assert that every part the model
 * needs (tool name, question text, option labels) is actually present, and so the
 * trigger that fired is named instead of asserted. "AGENTS.md §5 hard trigger
 * matched" was true for the `b:` clauses and a fiction for `a:path` hitting a path in
 * a subagent's task prompt — the model reads this text and acts on it, so it must not
 * claim more than was checked.
 *
 * @param clause - the rule id that fired, e.g. `b:设计` or `c:material`.
 */
export function instructionFor(clause) {
  return [
    `[depth-elevation gate] AGENTS.md §5 hard trigger matched (${clause}). Your FIRST action this`,
    'turn must be ask_user_question, before any file read, search, or write:',
    '  id: elevation, header: 深度',
    '  question: 💡 检测到该任务具备深挖潜力，是否需要按【顶尖专家深度与野心】重构此任务？',
    '            （将先梳理：①顶级专家未想之策 ②原始底层素材 ③专业工具与模型 ④客观外部裁判标准，重写提示词后再执行）',
    '  options: 升维：按专家级做（推荐） / 直接做：先出能用的版本',
    'Do not decide the task is trivial and skip it; that call belongs to the user.',
    'If the user picks 升维: before any task work, your reply must first give the FULL rewritten',
    'prompt with four named parts — ①验收标准（怎样算做完） ②原始素材清单（用户实际给了什么）',
    '③方法与工具 ④外部裁判方式（哪个客观检查判定对错）. Reciting the four steps without',
    'producing this artifact does not count as executing them.',
  ].join('\n');
}

/** The instruction for the common case, kept for callers that do not have a clause. */
export const INSTRUCTION = instructionFor('b:设计');

/** Strip harness-injected context so only the human's own words are judged. */
export function humanText(prompt) {
  return String(prompt ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<hindsight_knowledge_refresh>[\s\S]*?<\/hindsight_knowledge_refresh>/g, '')
    .replace(/<hindsight_knowledge>[\s\S]*?<\/hindsight_knowledge>/g, '')
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/g, '')
    .trim();
}

/** Join one claimed message batch into the single text the matcher reads. */
export function batchText(messages) {
  return humanText(
    (messages ?? [])
      .flatMap((message) => message.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n'),
  );
}

/** The only source kind that may trigger an offer. */
export const HUMAN_SOURCE = 'user';

/**
 * Decide whether a claimed batch must be gated.
 *
 * This is the whole policy — the seam wiring in `apply()` is only transport. Keeping
 * it here is what lets the history replay exercise the shipping decision instead of
 * a reimplementation of it: the replay hands this function the exact batch the harness
 * handed the plugin.
 *
 * @param batch - the claimed messages (`preStep` payload `messages`).
 * @param context - `{ delegationDepth, alreadyAsked }` for this agent.
 * @param config - resolved plugin config.
 * @returns the matched clause id, or null when the batch stays exempt.
 */
export function decideGate(batch, context, config) {
  const messages = batch ?? [];
  if (messages.length === 0) return null;
  if (!config.enabled) return null;
  // A subagent has no answerer: the harness refuses human interaction from a live
  // child (dsh-user-questions README:33), so an offer there can only burn a turn.
  if ((context?.delegationDepth ?? 0) > 0) return null;
  // Only the human's own message may trigger the offer. The inbox also carries
  // approvals, subagent reports, job notices and team messages.
  if (!messages.some((message) => message.source?.kind === HUMAN_SOURCE)) return null;
  if (context?.alreadyAsked) return null;
  return matchClause(batchText(messages), config);
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
  if (t.length <= 30 && config.exemptPrefix.some((p) => t.startsWith(p))) return null;
  if (t.length <= config.minChars) return null;                  // single-point query

  if (/https?:\/\//.test(t)) return 'c:link';                    // (c) link material
  if (/[A-Za-z]:\\|\b[\w-]{1,64}\.(?:py|md|xlsx|docx|json|html|ts|js|csv)\b/.test(t)) return 'a:path';
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
