"""Did the four promised steps actually happen after the user chose 升维?

The offer promises a specific method:
  ①顶级专家未想之策 ②原始底层素材 ③专业工具与模型 ④客观外部裁判标准

That is a process claim, and process claims are checkable. For every ELEVATE answer,
inspect what the model actually did next: did it load a skill, run a verifier, collect
raw data, or just start producing output?

    python .tmp/fidelity.py
"""

from __future__ import annotations

import glob
import json
import os
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

MARK = "[depth-elevation gate]"


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
        if not texts(d.get("content")).startswith(MARK):
            continue

        # find the answer
        answer_at = None
        label = None
        for j in range(i + 1, min(i + 80, len(events))):
            nxt = events[j]
            data = nxt.get("data") or {}
            if nxt.get("type") != "tool/result":
                continue
            msg = data.get("message") or {}
            if (msg.get("source") or {}).get("kind") != "tool":
                continue
            text = texts(msg.get("content"))
            try:
                payload = json.loads(text)
            except (ValueError, TypeError):
                continue
            for item in payload.get("answers") or []:
                if item.get("id") == "elevation":
                    lbl = (item.get("selected") or [""])[0] or item.get("custom") or ""
                    answer_at = j
                    label = lbl
            if answer_at:
                break
        if answer_at is None:
            continue
        if "升维" not in label:
            continue

        # what happened in the next N steps
        calls = []
        for nxt in events[answer_at + 1:answer_at + 400]:
            if nxt.get("type") == "user/message":
                b = texts((nxt.get("data") or {}).get("content"))
                if b and not b.startswith(MARK) and (nxt.get("data") or {}).get("source", {}).get("kind") == "user":
                    break
            if nxt.get("type") == "assistant/message":
                msg = (nxt.get("data") or {}).get("message") or {}
                for blk in (msg.get("content") or []):
                    if isinstance(blk, dict) and blk.get("type") == "tool-call":
                        calls.append(blk.get("name"))

        skill = "skill" in calls
        verifier = any(c in calls for c in ("ops_bash", "pwsh")) and False  # too coarse
        print(f"sid={sid[:18]}  answer={label!r}")
        print(f"  first 12 tool calls: {calls[:12]}")
        print(f"  loaded a skill: {skill}")
        print()
