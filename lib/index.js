/**
 * dsh-depth-elevation — enforce AGENTS.md §5 (主动升维询问机制) at the harness
 * level instead of relying on the model to police itself.
 *
 * Why a plugin rather than a prompt rule: under the prompt-only rule the model
 * talked itself out of the offer ("skip it to avoid annoying") because nothing
 * stopped it. This plugin attaches a sourced instruction to the entering message
 * batch at `agent/pre-step`, so the instruction is part of the turn the model sees.
 * Replaying the shipped code over this machine's real claimed batches, 5 of 5 gated
 * turns that reached the model opened with ask_user_question — see docs/AUDIT.md.
 *
 * Design notes:
 *  - `additionalContext` semantics, never `reject`: rejecting a pre-step drops
 *    the user's own message. A missed offer is recoverable; a lost prompt is not.
 *  - one gate per session: without it, a working session re-fires on every
 *    follow-up (measured 4 fires in one 24-turn session). The latch is released
 *    only after the instruction is actually delivered, so a rejected step does
 *    not consume it.
 *  - the decision is a pure function (`decideGate`) so the history replay can
 *    exercise the shipping policy against real claimed batches, not a copy.
 *  - state lives in a module-level `Set`, not in a marker file, so it costs no
 *    filesystem I/O per turn. It is process state: a plugin reload forgets it.
 *
 * @module dsh-depth-elevation
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';

import {
  DEFAULT_EXEMPT_PREFIX,
  DEFAULT_VERBS,
  decideGate,
  instructionFor,
} from './decide.js';

export { INSTRUCTION, batchText, decideGate, instructionFor, matchClause } from './decide.js';

export const name = 'depth-elevation';

/**
 * The `agents` service: the contractual way to tell a root from a child.
 * The pre-step payload declares `Agent { id: SessionId }` and nothing else —
 * `agent.session` worked only because the runtime happened to hand over its
 * internal object, and a refactor there would silently revive both the
 * resume re-gate and the subagent bugs this plugin already fixed once.
 */
export const inject = ['agents'];

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('Gate substantive prompts. Turn off to disable the plugin without unmounting it.'),
  verbs: z.array(z.string()).default(DEFAULT_VERBS)
    .description('Clause (b) trigger verbs — a prompt containing any of these gates.'),
  // No `exemptExact` key: every such prompt is already shorter than `minChars`, so
  // the length rule shadows it and the knob could never change a decision. A config
  // key nobody can observe is a promise the plugin does not keep — deleting it is
  // smaller than keeping a rule that only exists to look like one.
  exemptPrefix: z.array(z.string()).default(DEFAULT_EXEMPT_PREFIX)
    .description('Short follow-ups (<30 chars) starting with these never gate.'),
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
const asked = new Set();

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
    exemptPrefix: config.exemptPrefix ?? DEFAULT_EXEMPT_PREFIX,
    minChars: config.minChars ?? 6,
    listMinChars: config.listMinChars ?? 40,
    materialMinChars: config.materialMinChars ?? 150,
    deliverableMinChars: config.deliverableMinChars ?? 20,
  };

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    // The whole policy lives in decideGate so the history replay can exercise the
    // shipping decision; this handler is only transport plus the one-shot latch.
    //
    // `agent.id` IS the session id (`agentLoop.create(id: SessionId, ...)`), and
    // the contractual child check is the agents service's `roots()` list — never
    // the incidental `agent.session` field, which is not part of the payload
    // contract. When the service is absent (older runtime), fail open: gating a
    // root one extra time is recoverable, silently disabling the plugin is not.
    const key = agent?.id ?? ctx;
    const roots = ctx.agents?.roots?.() ?? [];
    const isChild = ctx.agents ? !roots.some((root) => root?.id === key) : false;
    const clause = decideGate(messages, {
      delegationDepth: isChild ? 1 : 0,
      alreadyAsked: asked.has(key),
    }, resolved);
    if (clause === null) return next();

    // Attach the instruction to the batch the model is about to receive. Sourced
    // so it can never be mistaken for the user's own words.
    const downstream = await next();
    if (downstream.kind !== 'enter') return downstream;
    asked.add(key);   // only consume the gate when it is actually delivered
    const context = createUserMessage({
      content: [{ type: 'text', text: instructionFor(clause) }],
      source: { kind: 'depth-elevation' },
    });
    ctx.logger?.debug?.(`depth-elevation: gated turn (${clause})`);
    return { ...downstream, messages: [...downstream.messages, context] };
  });
}
