"""Criterion validity of the trigger: did the user actually accept the offer?

The plugin's own justification for firing is "this task has depth potential". A
criterion measure that is independent of the rule is the user's revealed preference:
when the offer appeared, did they pick 升维 or 直接做?

If most answers are "直接做", the trigger is firing on tasks the user did not consider
deep — the rule is over-firing and the acceptance rate is the evidence.

    python .tmp/acceptance.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

MARK = "[depth-elevation gate]"

records = []

for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    sid = os.path.basename(os.path.dirname(path))
    events = []
    for line in raw.split("\n"):
        line = line.strip()
        if line:
            try:
                events.append(json.loads(line))
            except ValueError:
                pass

    for i, rec in enumerate(events):
        if rec.get("type") != "user/message":
            continue
        d = rec.get("data") or {}
        body = "".join(p.get("text", "") for p in (d.get("content") or [])
                       if isinstance(p, dict) and isinstance(p.get("text"), str))
        if not body.startswith(MARK):
            continue
        impl = (d.get("source") or {}).get("kind")

        # the human prompt this gate judged
        human = ""
        for back in range(i - 1, -1, -1):
            p = events[back]
            if p.get("type") != "user/message":
                continue
            pd = p.get("data") or {}
            if (pd.get("source") or {}).get("kind") != "user":
                continue
            human = "".join(x.get("text", "") for x in (pd.get("content") or [])
                            if isinstance(x, dict) and isinstance(x.get("text"), str))
            break

        # the ask_user_question tool call and its answer
        answer = None
        for nxt in events[i + 1:i + 60]:
            t = nxt.get("type")
            data = nxt.get("data") or {}
            if t == "assistant/message":
                msg = data.get("message") or {}
                has_ask = any(isinstance(b, dict) and b.get("type") == "tool-call"
                              and b.get("name") == "ask_user_question"
                              for b in (msg.get("content") or []))
                if not has_ask:
                    continue
            if t == "tool/result":
                message = data.get("message") or {}
                src = (message.get("source") or {}).get("kind")
                if src != "tool":
                    continue
                text = "".join(x.get("text", "") for x in (message.get("content") or [])
                               if isinstance(x, dict) and isinstance(x.get("text"), str))
                if "answers" in text or "pending" in text:
                    answer = text
                    break
            if t == "turn/end":
                break

        choice = "no-answer"
        if answer:
            try:
                payload = json.loads(answer)
            except ValueError:
                payload = {}
            if payload.get("pending"):
                choice = "pending(timeout)"
            else:
                for item in payload.get("answers") or []:
                    if item.get("id") != "elevation":
                        continue
                    selected = item.get("selected") or []
                    custom = item.get("custom")
                    label = (selected[0] if selected else custom) or ""
                    if "升维" in label:
                        choice = "ELEVATE"
                    elif "直接" in label:
                        choice = "DIRECT"
                    elif not selected and not custom:
                        choice = "skipped"
                    else:
                        choice = f"other:{str(label)[:20]}"
        records.append({"sid": sid[:18], "impl": impl, "human": human[:60], "choice": choice})

tally = Counter(r["choice"].split(":", 1)[0] for r in records)
print(f"gate fires: {len(records)}\n")
for k, v in tally.most_common():
    print(f"  {v:3d}  {k}")

answered = tally["ELEVATE"] + tally["DIRECT"]
if answered:
    print(f"\nacceptance rate (answered only): {tally['ELEVATE']}/{answered} = "
          f"{100 * tally['ELEVATE'] / answered:.0f}% chose 升维")

print("\nper fire:")
for r in records:
    if r["choice"] in ("ELEVATE", "DIRECT", "skipped"):
        print(f"  {r['choice']:8s} {r['impl']:16s} {r['human']!r}")
