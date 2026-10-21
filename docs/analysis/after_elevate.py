"""What did the model actually do right after the user chose 升维?

The rule says: 用户选「升维」→ 立即执行上述四步法，用工业级标准重写提示词再落地。
So the contract is: restate the prompt at expert level, then execute.

Inspect the first assistant output after the answer, verbatim, for all three ELEVATE
cases. If the four steps ran, they should be visible. If the model just started
working, the mechanism is nominal.

    python .tmp\after_elevate.py
"""

from __future__ import annotations

import glob
import json
import os
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

GATE = "[depth-elevation gate]"


def texts(content):
    out = []
    for p in content or []:
        if isinstance(p, dict) and isinstance(p.get("text"), str):
            out.append(p["text"])
    return "".join(out)


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

        print("=" * 100)
        print(f"{sid}  -> {label}")
        shown = 0
        for nxt in events[answer_at + 1:]:
            t = nxt.get("type")
            data = nxt.get("data") or {}
            if t == "user/message":
                b = texts(data.get("content"))
                if b and (data.get("source") or {}).get("kind") == "user":
                    break
            if t == "assistant/message":
                msg = data.get("message") or {}
                calls = [b.get("name") for b in (msg.get("content") or [])
                         if isinstance(b, dict) and b.get("type") == "tool-call"]
                body = texts(msg.get("content"))
                print(f"  assistant calls={calls}")
                if body.strip():
                    print(f"    text: {body.strip()[:400]!r}")
                shown += 1
                if shown >= 3:
                    break
        print()
