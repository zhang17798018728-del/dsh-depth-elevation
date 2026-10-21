"""Elevation fidelity: did the model actually produce the rewritten prompt?

docs/RULE-SCIENCE.md 问题五 measured 0/3 execution of the four-step method
because the steps had no observable artifact. The current instruction demands
one concrete artifact before any task work — the FULL rewritten prompt with:
  ①验收标准 ②原始素材清单 ③方法与工具 ④外部裁判方式

This extractor walks each session transcript and, for every elevation ask the
user answered with 升维, classifies the FIRST visible assistant reply after the
answer:

  pass      — the reply contains all four named parts
  fail      — a reply exists but misses one or more parts
  no-reply  — no visible assistant text after the answer (interrupted turn)

Rows are separated by era:
  new          — the gate instruction that fired contains 外部裁判方式 (post-R13)
  legacy       — older plugin instruction that never demanded an artifact
                 (baseline only; it was promised nothing, so never asserted)
  unattributed — an elevation ask with NO gate instruction in this transcript:
                 hook-era injections (source hooks-claude-code) and hand-asked
                 questions. Informational only — they are not evidence about
                 the plugin either way.

STATUS: this measures whether the demand works; it does NOT enforce it. As of the
commit that added it there are zero `new` rows, because every elevation answer on
this machine predates the instruction change. The self-check proves the classifier
points the right way on fixtures; a pass rate needs a corpus that post-dates R13.
Read `--stats` as a baseline, never as evidence the demand succeeded.

`test/fidelity.mjs` wraps this: it always runs `--self-check`, scans the corpus when
one exists, hard-fails on any post-fix reply that misses the artifact, and says
"nothing asserted" when there are no post-fix samples instead of reporting a pass.

    python test/_elevation_fidelity.py               # JSON rows to stdout
    python test/_elevation_fidelity.py --stats       # summary + pass rate
    python test/_elevation_fidelity.py --self-check  # fixture proof, CI-safe
"""

from __future__ import annotations

import glob
import json
import os
import sys
from typing import Iterable

from compression import zstd

GATE_MARK = "[depth-elevation gate]"
ARTIFACT_MARK = "外部裁判方式"           # present only in post-R13 instructions
PARTS = ["验收标准", "原始素材清单", "方法与工具", "外部裁判方式"]
ELEVATE = "升维"

# Root of the session store. Overridable so the end-to-end path (zstd file -> rows ->
# rate) can be exercised against a synthetic corpus, instead of either polluting the
# real session store or only testing analyze_events() and skipping the file plumbing.
SESSIONS_ROOT = os.environ.get("DSH_FIDELITY_SESSIONS") or os.path.expanduser("~/.dsh/sessions")
SESSIONS = os.path.join(SESSIONS_ROOT, "*", "*", "session.v4.jsonl.zstd")


def message_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part["text"] for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def assistant_visible_text(message: dict) -> str:
    """The user-visible reply only: text parts, never reasoning or tool calls."""
    content = message.get("content")
    if not isinstance(content, list):
        return content if isinstance(content, str) else ""
    return "\n".join(
        part["text"] for part in content
        if isinstance(part, dict) and part.get("type") == "text"
        and isinstance(part.get("text"), str)
    )


def analyze_events(events: Iterable[dict], sid: str) -> list[dict]:
    """Pure core: one list of transcript events -> fidelity rows.

    Kept separate from the zstd/file plumbing so --self-check can feed it
    synthetic fixtures and the corpus scan can feed it real lines — the thing
    being proven in CI is the thing that runs in production.
    """
    rows: list[dict] = []
    gate_era: str | None = None          # era of the most recent gate instruction
    pending: dict | None = None          # an elevation call awaiting its result

    for rec in events:
        kind = rec.get("type")
        data = rec.get("data") or {}
        seq = rec.get("seq") or 0

        if kind == "user/message":
            text = message_text(data)
            if text.startswith(GATE_MARK):
                # Attribution + era detection in one: this exact instruction is
                # what the model was told to do.
                gate_era = "new" if ARTIFACT_MARK in text else "legacy"
            continue

        if kind == "tool/call" and data.get("name") == "ask_user_question":
            args = str(data.get("arguments"))
            if '"elevation"' in args or "id\": \"elevation" in args or ELEVATE in args:
                pending = {"callId": data.get("callId"), "era": gate_era, "at": seq}
            continue

        if kind == "tool/result" and pending:
            message = data.get("message") or {}
            if message.get("toolCallId") != pending.get("callId"):
                continue
            text = message_text(message)
            elevated = None
            try:
                payload = json.loads(text)
                answers = payload.get("answers") or []
                for answer in answers:
                    if answer.get("id") == "elevation":
                        selected = answer.get("selected") or []
                        elevated = any(s.startswith(ELEVATE) for s in selected)
            except ValueError:
                pass
            row = {
                "sid": sid,
                "era": pending["era"] or "unattributed",
                "elevated": elevated,      # None = unparseable; False = 直接做
                "at": pending["at"],
                "resultSeq": seq,
                "outcome": None,
            }
            if elevated:
                rows.append(row)
            pending = None
            continue

        # The first visible assistant reply after an elevated answer is the one
        # the instruction holds accountable. Multiple open rows are possible when
        # a session gates again on a later turn: fill the earliest open row whose
        # answer precedes this reply.
        if kind == "assistant/message":
            row = next((r for r in rows
                        if r["outcome"] is None and seq > r["resultSeq"]), None)
            if row is None:
                continue
            text = assistant_visible_text(data.get("message") or {})
            if not text:
                continue
            found = sum(1 for part in PARTS if part in text)
            row["outcome"] = "pass" if found == len(PARTS) else "fail"
            row["markers"] = f"{found}/{len(PARTS)}"
            row["excerpt"] = text[:120]

    for row in rows:
        if row["outcome"] is None:
            row["outcome"] = "no-reply"
            row["markers"] = "0/4"
            row["excerpt"] = ""
    return rows


def scan_transcript(path: str) -> list[dict]:
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        return []
    sid = os.path.basename(os.path.dirname(path))
    events = []
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
    return analyze_events(events, sid)


# ---------------------------------------------------------------------------
# Self-check: synthetic fixtures prove the classifier itself, no corpus needed.
# Every case here has a known answer — if the extractor drifts, this fails.
# ---------------------------------------------------------------------------

def _mk(seq, kind, data):
    return {"type": kind, "seq": seq, "time": seq, "data": data}


def _gate(new: bool, seq: int):
    tail = " ④外部裁判方式" if new else ""
    return _mk(seq, "user/message", {
        "content": [{"type": "text", "text": f"{GATE_MARK} x\noptions: 升维{tail}"}],
    })


def _ask(seq):
    return _mk(seq, "tool/call", {
        "name": "ask_user_question", "callId": f"c{seq}",
        "arguments": json.dumps({"questions": [{"id": "elevation"}]}),
    })


def _answer(seq, selected):
    return _mk(seq, "tool/result", {
        "message": {"role": "tool", "toolCallId": f"c{seq - 1}",
                    "content": [{"type": "text", "text": json.dumps(
                        {"answers": [{"id": "elevation", "selected": [selected]}]})}]},
    })


def _reply(seq, text, reasoning=""):
    parts = []
    if reasoning:
        parts.append({"type": "reasoning", "text": reasoning})
    parts.append({"type": "text", "text": text})
    return _mk(seq, "assistant/message", {"message": {"role": "assistant", "content": parts}})


def self_check() -> int:
    good = "①验收标准 … ②原始素材清单 … ③方法与工具 … ④外部裁判方式"
    bad = "我先看一下目录。"

    cases = [
        ("new-era artifact present -> pass",
         [_gate(True, 1), _ask(2), _answer(3, "升维：按专家级做（推荐）"), _reply(4, good)],
         [("new", "pass", "4/4")]),
        ("new-era reply without artifact -> fail",
         [_gate(True, 1), _ask(2), _answer(3, "升维"), _reply(4, bad)],
         [("new", "fail", "0/4")]),
        ("reasoning gloats, visible text misses -> fail (visible reply is judged)",
         [_gate(True, 1), _ask(2), _answer(3, "升维"), _reply(4, bad, reasoning=good)],
         [("new", "fail", "0/4")]),
        ("legacy gate -> era legacy, still measured",
         [_gate(False, 1), _ask(2), _answer(3, "升维"), _reply(4, bad)],
         [("legacy", "fail", "0/4")]),
        ("直接做 -> ignored, no row",
         [_gate(True, 1), _ask(2), _answer(3, "直接做：先出能用的版本"), _reply(4, bad)],
         []),
        ("no reply ever -> no-reply",
         [_gate(True, 1), _ask(2), _answer(3, "升维")],
         [("new", "no-reply", "0/4")]),
        ("late compliance does not count: first visible reply lacks artifact",
         [_gate(True, 1), _ask(2), _answer(3, "升维"), _reply(4, bad), _reply(5, good)],
         [("new", "fail", "0/4")]),
    ]

    failed = 0
    for label, events, expect in cases:
        rows = analyze_events(events, "fixture")
        got = [(r["era"], r["outcome"], r["markers"]) for r in rows]
        if got != expect:
            print(f"FAIL  self-check {label}: got {got}, want {expect}")
            failed += 1
        else:
            print(f"ok    {label}")
    return 1 if failed else 0


def main() -> int:
    if "--self-check" in sys.argv:
        return self_check()

    rows: list[dict] = []
    for path in sorted(glob.glob(SESSIONS)):
        rows.extend(scan_transcript(path))

    if "--stats" in sys.argv:
        sys.stdout.reconfigure(encoding="utf-8")
        for era in ("new", "legacy", "unattributed"):
            era_rows = [r for r in rows if r["era"] == era]
            if not era_rows:
                continue
            passed = sum(1 for r in era_rows if r["outcome"] == "pass")
            fails = sum(1 for r in era_rows if r["outcome"] == "fail")
            noreply = sum(1 for r in era_rows if r["outcome"] == "no-reply")
            answered = passed + fails
            rate = f"{100.0 * passed / answered:.0f}%" if answered else "n/a"
            print(f"{era:7s} elevated={len(era_rows)} pass={passed} fail={fails} "
                  f"no-reply={noreply} | artifact rate (answered): {rate}")
        return 0

    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(rows, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
