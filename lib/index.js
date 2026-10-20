/**
 * dsh-depth-elevation — enforce AGENTS.md §5 (主动升维询问机制) at the harness
 * level instead of relying on the model to police itself.
 *
 * Why a plugin rather than a prompt rule: measured over 62 real turns, the
 * prompt-only rule gated 1 independent task. The model talked itself out of the
 * offer ("skip it to avoid annoying") because nothing stopped it. This plugin
 * attaches a sourced instruction to the entering message batch at
 * `agent/pre-step`, so the instruction is part of the turn the model sees.
 *
 * Design notes:
 *  - `additionalContext` semantics, never `reject`: rejecting a pre-step drops
 *    the user's own message. A missed offer is recoverable; a lost prompt is not.
 *  - one gate per session: without it, a working session re-fires on every
 *    follow-up (measured 4 fires in one 24-turn session).
 *  - state lives in `ctx.state` (session-scoped, in-memory), not in a marker
 *    file, so it costs no filesystem I/O per turn.
 *
 * @module dsh-depth-elevation
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import {
  DEFAULT_EXEMPT_EXACT,
  DEFAULT_EXEMPT_PREFIX,
  DEFAULT_VERBS,
  INSTRUCTION,
  humanText,
  matchClause,
} from './decide.js';

export { INSTRUCTION, humanText, matchClause } from './decide.js';

export const name = 'depth-elevation';

/** No external services: this plugin only observes the agent loop. */
export const inject = [];

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('Gate substantive prompts. Turn off to disable the plugin without unmounting it.'),
  verbs: z.array(z.string()).default(DEFAULT_VERBS)
    .description('Clause (b) trigger verbs — a prompt containing any of these gates.'),
  exemptExact: z.array(z.string()).default(DEFAULT_EXEMPT_EXACT)
    .description('Exact prompts that never gate, regardless of length ("继续", "好", ...).'),
  exemptPrefix: z.array(z.string()).default(DEFAULT_EXEMPT_PREFIX)
    .description('Prompts starting with these never gate — follow-up edits.'),
  minChars: z.natural().default(6)
    .description('Prompts at or below this length are single-point queries and never gate.'),
  listMinChars: z.natural().default(40)
    .description('Minimum length for a bullet/numbered list to count as clause (a).'),
  materialMinChars: z.natural().default(150)
    .description('Pasted material threshold — clause (c).'),
  deliverableMinChars: z.natural().default(20)
    .description('Minimum length for a deliverable request (给我/帮我/生成/…) to count as clause (d).'),
});

/** One gate per session: a follow-up in the same session must not re-ask. */
const asked = new WeakSet();

/**
 * @param ctx - Cordis context.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  // Resolve once at mount: the config object is schema-volatile, but the matcher
  // should not re-read defaults on every turn.
  const resolved = {
    enabled: config.enabled ?? true,
    verbs: config.verbs ?? DEFAULT_VERBS,
    exemptExact: config.exemptExact ?? DEFAULT_EXEMPT_EXACT,
    exemptPrefix: config.exemptPrefix ?? DEFAULT_EXEMPT_PREFIX,
    minChars: config.minChars ?? 6,
    listMinChars: config.listMinChars ?? 40,
    materialMinChars: config.materialMinChars ?? 150,
    deliverableMinChars: config.deliverableMinChars ?? 20,
  };

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (messages.length === 0) return next();
    if (!resolved.enabled) return next();

    const text = humanText(
      messages
        .flatMap((message) => message.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n'),
    );
    const clause = matchClause(text, resolved);
    if (clause === null) return next();

    const key = agent ?? ctx;
    if (asked.has(key)) return next();   // one ask per session

    // Attach the instruction to the batch the model is about to receive. Sourced
    // so it can never be mistaken for the user's own words.
    asked.add(key);
    const downstream = await next();
    if (downstream.kind !== 'enter') return downstream;
    const context = createUserMessage({
      content: [{ type: 'text', text: INSTRUCTION }],
      source: { kind: 'depth-elevation' },
    });
    ctx.logger?.debug?.(`depth-elevation: gated turn (${clause})`);
    return { ...downstream, messages: [...downstream.messages, context] };
  });
}
