"""Generate a synthetic post-R13 (new-era) corpus, then measure it end to end.

Why this exists
---------------
`test/fidelity.mjs` reports "NO post-fix samples yet" because every elevation answer on
this machine predates the artifact demand. That means the new-era branch of the scorer
has never actually run on data — only the fixtures in `--self-check` touch it, and
those call `analyze_events()` directly, skipping the zstd file plumbing and the
`--stats` aggregation.

This generates real session transcripts in the same on-disk shape the harness writes
(`<root>/<workspace>/<session>/session.v4.jsonl.zstd`, zstd-compressed JSON lines),
points the scanner at them via `DSH_FIDELITY_SESSIONS`, and checks that:

    1. every generated row is attributed to era `new`
    2. the pass/fail split matches what was planted
    3. the printed artifact rate equals the planted ratio
    4. `no-reply` rows are counted separately, never folded into the rate
    5. a `直接做` answer contributes no row at all

The corpus is written under `.tmp/` — never into `~/.dsh/sessions`, so the real
measurement stays honest.

    python test/_fidelity_corpus.py            # build + verify, print the report
    python test/_fidelity_corpus.py --keep     # keep .tmp corpus for inspection
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

def _zstd():
    """Import `compression.zstd` (Python 3.14+) on demand.

    The corpus has to be written as real zstd frames, so this whole check needs 3.14.
    Importing lazily keeps the failure legible: the caller reports "needs Python 3.14"
    instead of dying at import time with ModuleNotFoundError, which on a bare CI runner
    reads like a broken test rather than a missing interpreter.
    """
    from compression import zstd
    return zstd

HERE = os.path.dirname(os.path.abspath(__file__))
SCANNER = os.path.join(HERE, "_elevation_fidelity.py")
CORPUS = os.path.join(os.path.dirname(HERE), ".tmp", "fidelity-corpus")

GATE_MARK = "[depth-elevation gate]"
ELEVATE_LABEL = "升维：按专家级做（推荐）"
DIRECT_LABEL = "直接做：先出能用的版本"

# The post-R13 instruction: it must contain ARTIFACT_MARK (外部裁判方式) for the
# scanner to classify the row as `new` era.
NEW_GATE = (
    f"{GATE_MARK} AGENTS.md §5 hard trigger matched (b:整理). Your FIRST action this\n"
    "turn must be ask_user_question, before any file read, search, or write:\n"
    "  id: elevation, header: 深度\n"
    "  question: 💡 检测到该任务具备深挖潜力…\n"
    "  options: 升维：按专家级做（推荐） / 直接做：先出能用的版本\n"
    "If the user picks 升维: before any task work, your reply must first give the FULL rewritten\n"
    "prompt with four named parts — ①验收标准（怎样算做完） ②原始素材清单（用户实际给了什么）\n"
    "③方法与工具 ④外部裁判方式（哪个客观检查判定对错）."
)

# A pre-R13 instruction, for contrast: same shape, no artifact demand.
LEGACY_GATE = (
    f"{GATE_MARK} AGENTS.md §5 hard trigger matched. Your FIRST action this\n"
    "turn must be ask_user_question, before any file read, search, or write:\n"
    "  options: 升维：按专家级做（推荐） / 直接做：先出能用的版本"
)

GOOD_REPLY = (
    "重构后的提示词：\n"
    "①验收标准：四套测试全绿且回放无法解释漏拦为 0。\n"
    "②原始素材清单：用户给了 lib/ 两个文件与 148 份 transcript。\n"
    "③方法与工具：node 测试套件 + python 语料回放 + asar 反编译。\n"
    "④外部裁判方式：以磁盘上真实发生的触发为裁判，不接受自评。\n"
)

# Misses exactly one part (方法与工具) — the most common realistic failure.
PARTIAL_REPLY = (
    "重构后的提示词：\n"
    "①验收标准：测试全绿。\n"
    "②原始素材清单：lib/ 两个文件。\n"
    "④外部裁判方式：跑真实语料。\n"
)


def event(seq: int, kind: str, data: dict) -> dict:
    return {"type": kind, "seq": seq, "time": 1792550000000 + seq * 1000, "data": data}


def user_message(seq: int, text: str, source: str = "user") -> dict:
    return event(seq, "user/message", {
        "content": [{"type": "text", "text": text}],
        "source": {"kind": source},
        "role": "user",
    })


def ask_call(seq: int, call_id: str) -> dict:
    return event(seq, "tool/call", {
        "name": "ask_user_question",
        "callId": call_id,
        "arguments": json.dumps({"questions": [{"id": "elevation"}]}, ensure_ascii=False),
    })


def ask_result(seq: int, call_id: str, label: str) -> dict:
    payload = {"answers": [{"id": "elevation", "selected": [label]}]}
    return event(seq, "tool/result", {
        "message": {
            "role": "tool",
            "toolCallId": call_id,
            "source": {"kind": "tool", "callId": call_id},
            "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        },
    })


def assistant(seq: int, text: str, reasoning: str = "") -> dict:
    parts = []
    if reasoning:
        parts.append({"type": "reasoning", "text": reasoning})
    parts.append({"type": "text", "text": text})
    return event(seq, "assistant/message", {
        "message": {"role": "assistant", "content": parts},
    })


# ---------------------------------------------------------------------------
# The planted corpus. Every case states its expected row, so the check is exact.
# ---------------------------------------------------------------------------

CASES = [
    # name,             gate,         answer,        reply,          expected
    ("new-pass",        NEW_GATE,     ELEVATE_LABEL, GOOD_REPLY,     ("new", "pass", "4/4")),
    ("new-fail-partial", NEW_GATE,    ELEVATE_LABEL, PARTIAL_REPLY,  ("new", "fail", "3/4")),
    ("new-fail-empty",  NEW_GATE,     ELEVATE_LABEL, "我先看看目录。", ("new", "fail", "0/4")),
    ("new-no-reply",    NEW_GATE,     ELEVATE_LABEL, None,           ("new", "no-reply", "0/4")),
    ("new-direct",      NEW_GATE,     DIRECT_LABEL,  "好的，直接做。", None),
    ("new-pass-2",      NEW_GATE,     ELEVATE_LABEL, GOOD_REPLY,     ("new", "pass", "4/4")),
    ("legacy-fail",     LEGACY_GATE,  ELEVATE_LABEL, "我先看看。",    ("legacy", "fail", "0/4")),
]

# Artifact-only reasoning must NOT count: only the visible reply is judged.
REASONING_ONLY_CASE = (
    "new-reasoning-only",
    NEW_GATE,
    ELEVATE_LABEL,
    "我先看看目录。",
    "①验收标准 ②原始素材清单 ③方法与工具 ④外部裁判方式",
    ("new", "fail", "0/4"),
)


def build_case(name: str, gate: str, answer: str, reply, reasoning: str = "") -> list[dict]:
    events = [
        user_message(1, "把这次的改动整理一下", "user"),
        user_message(2, gate, "depth-elevation"),
        ask_call(3, f"call_{name}"),
        ask_result(4, f"call_{name}", answer),
    ]
    if reply is not None:
        events.append(assistant(5, reply, reasoning))
    return events


def write_session(root: str, workspace: str, name: str, events: list[dict]) -> str:
    folder = os.path.join(root, workspace, f"session-{name}")
    os.makedirs(folder, exist_ok=True)
    body = "\n".join(json.dumps(e, ensure_ascii=False) for e in events) + "\n"
    path = os.path.join(folder, "session.v4.jsonl.zstd")
    with open(path, "wb") as fh:
        fh.write(_zstd().compress(body.encode("utf-8")))
    return path


def expected_rows() -> list[tuple[str, str, str]]:
    rows = []
    for name, gate, answer, reply, expect in CASES:
        if expect is not None:
            rows.append(expect)
    name, gate, answer, reply, reasoning, expect = REASONING_ONLY_CASE
    rows.append(expect)
    return rows


def main() -> int:
    # Fixture labels and message excerpts are CJK; Windows stdout defaults to cp1252 and
    # would raise UnicodeEncodeError mid-report. Same guard as the scanner.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    try:
        _zstd()
    except ImportError:
        print("SKIP: this check needs Python 3.14+ (compression.zstd); "
              "the runner's python does not provide it")
        return 0
    if os.path.isdir(CORPUS):
        shutil.rmtree(CORPUS)
    planted = []
    for name, gate, answer, reply, expect in CASES:
        planted.append(write_session(CORPUS, "workspace-alpha", name,
                                     build_case(name, gate, answer, reply)))
    name, gate, answer, reply, reasoning, expect = REASONING_ONLY_CASE
    planted.append(write_session(CORPUS, "workspace-beta", name,
                                 build_case(name, gate, answer, reply, reasoning)))

    print(f"planted {len(planted)} synthetic sessions under {CORPUS}\n")

    env = {**os.environ, "DSH_FIDELITY_SESSIONS": CORPUS}
    raw = subprocess.run([sys.executable, SCANNER], capture_output=True, text=True,
                         encoding="utf-8", env=env)
    if raw.returncode != 0:
        print("FAIL  scanner exited", raw.returncode)
        print(raw.stderr[:800])
        return 1
    rows = json.loads(raw.stdout)

    failed = 0
    def check(label: str, ok: bool, detail: str = "") -> None:
        nonlocal failed
        if ok:
            print(f"ok    {label}")
        else:
            print(f"FAIL  {label}{chr(10) + '        ' + detail if detail else ''}")
            failed += 1

    # 1. row count matches the planted elevation answers that produced a row
    want = expected_rows()
    check(f"row count {len(rows)} == planned {len(want)}", len(rows) == len(want),
          f"got {[(r['era'], r['outcome']) for r in rows]}")

    # 2. every row is new-era except the deliberately legacy one
    eras = [r["era"] for r in rows]
    check("new-era rows were actually classified as new",
          eras.count("new") == len([e for e in want if e[0] == "new"]),
          f"eras={eras}")

    # 3. the pass/fail/no-reply split matches the plan exactly
    got = sorted((r["era"], r["outcome"], r.get("markers", "")) for r in rows)
    check("planted outcomes reproduced exactly", got == sorted(want),
          f"got={got} want={sorted(want)}")

    # 4. the 直接做 case produced no row at all
    check("a 直接做 answer contributes no row",
          not any(r["sid"].endswith("-direct") for r in rows))

    # 5. reasoning-only artifact does not count as pass
    reasoning_row = next((r for r in rows if r["sid"].endswith("-reasoning-only")), None)
    check("artifact appearing only in reasoning is judged fail",
          reasoning_row is not None and reasoning_row["outcome"] == "fail",
          f"got={reasoning_row}")

    # 6. the printed rate equals the planted ratio for the new era
    stats = subprocess.run([sys.executable, SCANNER, "--stats"], capture_output=True,
                           text=True, encoding="utf-8", env=env)
    print("\n--- --stats on the synthetic corpus ---")
    print(stats.stdout.rstrip())
    print()

    new_rows = [r for r in rows if r["era"] == "new"]
    answered = [r for r in new_rows if r["outcome"] in ("pass", "fail")]
    passes = sum(1 for r in answered if r["outcome"] == "pass")
    want_rate = round(100 * passes / len(answered))
    line = next((l for l in stats.stdout.split("\n") if l.startswith("new")), "")
    check(f"--stats reports the planted new-era rate {want_rate}%", f"{want_rate}%" in line, line)

    # 7. no-reply must be reported separately AND excluded from the denominator.
    #    Derived from the rows rather than hardcoded: an earlier version of this check
    #    hardcoded a count, was one off, and reported a failure that was in the check.
    no_reply = sum(1 for r in new_rows if r["outcome"] == "no-reply")
    expect_counts = (f"elevated={len(new_rows)} pass={passes} "
                     f"fail={len(answered) - passes} no-reply={no_reply}")
    check("--stats counts match the rows and exclude no-reply from the denominator",
          expect_counts in line, f"want {expect_counts!r} in {line!r}")

    print()
    if failed:
        print(f"{failed} FAILED")
        return 1
    print("PASS: new-era scoring works on real zstd transcripts end to end")
    print(f"      planted {len(new_rows)} new-era elevation answers: "
          f"{passes} pass / {len(answered) - passes} fail / {no_reply} no-reply "
          f"-> artifact rate {want_rate}% over {len(answered)} answered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
