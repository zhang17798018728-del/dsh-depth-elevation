"""The rule's own causal theory: does "reconstruct the prompt" improve the output?

The whole mechanism rests on one hypothesis:

    E[quality | expert-rewritten prompt] > E[quality | original prompt]

That is testable in principle and has never been tested here. What CAN be measured is
the intermediate step: after the user chose 升维, did the model actually restate the
prompt before working? If it did not, the mechanism the rule describes never ran, and
any quality difference would be attributable to something else.

    python .tmp\mechanism.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

GATE = "[depth-elevation gate]"
# Signals that the model restated/rebuilt the task before executing.
RESTATE = re.compile(r"(重写|重构后的提示词|以下是我重构|最终提示词|revised prompt|rewritten prompt)", re.I)


def texts(content):
    return "".join(p.get("text", "") for p in (content or [])
                   if isinstance(p, dict) and isinstance(p.get("text"), str))


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
        if not texts(d.get("content")).startswith(GATE):
            continue

        # find the answer
        answer_at, label = None, None
        for j in range(i + 1, min(i + 80, len(events))):
            nxt = events[j]
            data = nxt.get("data") or {}
            if nxt.get("type") != "tool/result":
                continue
            msg = data.get("message") or {}
            if (msg.get("source") or {}).get("kind") != "tool":
                continue
            try:
                payload = json.loads(texts(msg.get("content")))
            except (ValueError, TypeError):
                continue
            for item in payload.get("answers") or []:
                if item.get("id") == "elevation":
                    label = (item.get("selected") or [""])[0] or item.get("custom") or ""
                    answer_at = j
            if answer_at:
                break
        if answer_at is None or "升维" not in (label or ""):
            continue

        # did the model restate the prompt in its next few assistant texts?
        restated = False
        for nxt in events[answer_at + 1:answer_at + 40]:
            if nxt.get("type") != "assistant/message":
                continue
            msg = (nxt.get("data") or {}).get("message") or {}
            body = texts(msg.get("content"))
            if RESTATE.search(body):
                restated = True
                break
        print(f"{sid[:18]}  ELEVATE  restated the prompt: {restated}")
