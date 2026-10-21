"""Criterion validity: does a clause hit predict how much work the turn actually took?

The rule's implicit claim is "a hit means this task has depth". Depth has an observable
proxy the rule cannot influence: how many steps and tool calls the resulting turn
consumed. If clause-hit turns are no longer than clause-miss turns, the trigger is not
measuring anything the user would recognise as substantial work.

Structure note: the human message is appended AFTER turn/start and step/start (the
claimed batch is admitted into the step), so turns must be assembled by range, not by
"prompt then work".

    python .tmp/validity.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import statistics
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

VERBS = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构', '排查', '评估',
         '报告', '课件', '教学', '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化',
         '诊断', '材料', '创建', '开发', '实现', '做一个', '写成', '整成']
PATH = re.compile(r"[A-Za-z]:\\|\b[\w-]{1,64}\.(?:py|md|xlsx|docx|json|html|ts|js|csv)\b")
LINK = re.compile(r"https?://")


def clause_count(t: str) -> int:
    hits = 0
    if PATH.search(t) or "```" in t or "\t" in t or t.count("|") >= 4:
        hits += 1
    if any(v in t for v in VERBS):
        hits += 1
    if len(t) >= 150 or LINK.search(t):
        hits += 1
    if any(k in t for k in ("给我", "帮我", "生成", "输出", "整理成", "做成")):
        hits += 1
    return hits


rows = []

for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    depth = 0
    turn = 0
    prompt = None
    steps = 0
    calls = 0
    in_turn = False

    def close():
        if in_turn and prompt is not None:
            rows.append({"prompt": prompt, "steps": steps, "calls": calls})

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        t = rec.get("type")
        d = rec.get("data") or {}

        if t == "session":
            depth = rec.get("delegationDepth") or 0
            continue
        if depth:
            continue

        if t == "turn/start":
            close()
            turn = d.get("turn") or turn + 1
            prompt, steps, calls, in_turn = None, 0, 0, True
            continue
        if not in_turn:
            continue
        if t == "step/start":
            steps += 1
            continue
        if t == "user/message":
            if (d.get("source") or {}).get("kind") != "user":
                continue
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
            if body and prompt is None:
                prompt = body
            continue
        if t == "assistant/message":
            msg = d.get("message") or {}
            for b in (msg.get("content") or []):
                if isinstance(b, dict) and b.get("type") == "tool-call":
                    calls += 1
            continue
        if t == "turn/end":
            close()
            in_turn = False
            continue
    close()

groups: dict[int, list[dict]] = {}
for r in rows:
    groups.setdefault(min(clause_count(r["prompt"]), 3), []).append(r)

print(f"turns with a human prompt: {len(rows)}\n")
print(f"{'clauses':>8} {'n':>6} {'med steps':>10} {'med calls':>10} {'med chars':>10}")
for k in sorted(groups):
    g = groups[k]
    print(f"{k:>8} {len(g):>6} "
          f"{statistics.median(x['steps'] for x in g):>10.0f} "
          f"{statistics.median(x['calls'] for x in g):>10.0f} "
          f"{statistics.median(len(x['prompt']) for x in g):>10.0f}")

hit = [r for r in rows if clause_count(r["prompt"]) > 0]
miss = [r for r in rows if clause_count(r["prompt"]) == 0]
if hit and miss:
    hs, ms = statistics.median(x["steps"] for x in hit), statistics.median(x["steps"] for x in miss)
    hc, mc = statistics.median(x["calls"] for x in hit), statistics.median(x["calls"] for x in miss)
    print()
    print(f"hit  (n={len(hit):3d}): median steps {hs:.0f}, median calls {hc:.0f}")
    print(f"miss (n={len(miss):3d}): median steps {ms:.0f}, median calls {mc:.0f}")
    print()
    print(f"ratio hit/miss: steps {hs/max(ms,1e-9):.2f}, calls {hc/max(mc,1e-9):.2f}")
    print("  1.0 means the trigger does not separate long tasks from short ones.")
