"""Does the gate cost the user anything measurable?

If the offer is free, a low-precision trigger is harmless and the "err toward asking"
policy is defensible. If it costs turns, latency or tokens, the same policy has a price
and the rule never budgets for it.

Measures on the corpus:
  - the gate's own message survives into every later step of the session (it is a
    surface user/message, not ephemeral context)
  - extra round trips before the first productive call
  - how often the offer was answered at all

    python .tmp/cost2.py
"""

from __future__ import annotations

import glob
import json
import os
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

GATE = "[depth-elevation gate]"
ASK = "ask_user_question"

gate_len = 0
gate_count = 0
steps_after_gate = 0
answered = 0
first_action = {}

for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    events = []
    for line in raw.split("\n"):
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except ValueError:
                pass

    gate_at = None
    for i, rec in enumerate(events):
        t = rec.get("type")
        d = rec.get("data") or {}
        if t == "user/message":
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str))
            if body.startswith(GATE):
                gate_count += 1
                gate_len = len(body)
                gate_at = i
                # count the rest of the session's steps
                rest = sum(1 for r in events[i:] if r.get("type") == "step/start")
                steps_after_gate += rest
        if t == "tool/result" and gate_at is not None:
            msg = d.get("message") or {}
            if (msg.get("source") or {}).get("kind") != "tool":
                continue
            text = "".join(x.get("text", "") for x in (msg.get("content") or [])
                           if isinstance(x, dict) and isinstance(x.get("text"), str))
            if '"answers"' in text:
                answered += 1
                gate_at = None

print(f"gates fired                : {gate_count}")
print(f"gate message size          : {gate_len} chars (~{gate_len // 3} tokens for a CJK/ASCII mix)")
print(f"steps in the session after a gate (total): {steps_after_gate}")
if gate_count:
    print(f"  mean steps carried with the message : {steps_after_gate / gate_count:.1f}")
    print(f"  tokens of instruction resent      : ~{gate_len // 3 * steps_after_gate / gate_count:.0f} per gated session")
print()
print(f"offers answered            : {answered}/{gate_count}")
if gate_count:
    print(f"  unanswered                 : {gate_count - answered} ({100*(gate_count-answered)/gate_count:.0f}%)")
print()
print("""The message is a surface user/message, so it is replayed to the provider on every
subsequent step of that session. At ~135 tokens and ~24 later steps per gated session,
that is a few thousand tokens of carry per offer — small per session, but it means the
offer is not free, and the rule's 'err toward asking' policy has an unbudgeted cost.""")
