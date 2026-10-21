"""Control the confounder: failed turns are short, and failures are common here.

The first pass suggested clause-hit turns are SHORTER than misses (4 vs 8 steps).
That is almost certainly inverted causality: a turn that dies on a provider error
contributes few steps, and the gate adds a turn that is more likely to be interrupted.
Restrict to turns that completed normally, then compare again.

    python .tmp/validity2.py
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
    n = 0
    if PATH.search(t) or "```" in t or "\t" in t or t.count("|") >= 4:
        n += 1
    if any(v in t for v in VERBS):
        n += 1
    if len(t) >= 150 or LINK.search(t):
        n += 1
    if any(k in t for k in ("给我", "帮我", "生成", "输出", "整理成", "做成")):
        n += 1
    return n


rows = []

for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    depth = 0
    prompt = None
    steps = 0
    calls = 0
    in_turn = False
    outcome = None

    def close():
        if in_turn and prompt is not None:
            rows.append({"prompt": prompt, "steps": steps, "calls": calls, "outcome": outcome})

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
            prompt, steps, calls, in_turn, outcome = None, 0, 0, True, None
            continue
        if not in_turn:
            continue
        if t == "step/start":
            steps += 1
        elif t == "user/message":
            if (d.get("source") or {}).get("kind") != "user":
                continue
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
            if body and prompt is None:
                prompt = body
        elif t == "assistant/message":
            msg = d.get("message") or {}
            for b in (msg.get("content") or []):
                if isinstance(b, dict) and b.get("type") == "tool-call":
                    calls += 1
        elif t == "turn/end":
            outcome = (d.get("reason") or {}).get("kind")
            close()
            in_turn = False
    close()

for label, keep in (("all turns", lambda r: True),
                    ("completed only", lambda r: r["outcome"] == "completed")):
    subset = [r for r in rows if keep(r)]
    hit = [r for r in subset if clause_count(r["prompt"]) > 0]
    miss = [r for r in subset if clause_count(r["prompt"]) == 0]
    print(f"=== {label} ===")
    print(f"  n={len(subset)}  hit={len(hit)}  miss={len(miss)}")
    if not hit or not miss:
        print()
        continue
    hs = statistics.median(x["steps"] for x in hit)
    ms = statistics.median(x["steps"] for x in miss)
    hc = statistics.median(x["calls"] for x in hit)
    mc = statistics.median(x["calls"] for x in miss)
    print(f"  hit : med steps {hs:5.1f}  med calls {hc:5.1f}")
    print(f"  miss: med steps {ms:5.1f}  med calls {mc:5.1f}")
    print(f"  ratio: steps {hs/max(ms,1e-9):.2f}  calls {hc/max(mc,1e-9):.2f}")
    # mean too, medians hide long tails
    hsm = statistics.mean(x["steps"] for x in hit)
    msm = statistics.mean(x["steps"] for x in miss)
    print(f"  mean steps: hit {hsm:.1f}  miss {msm:.1f}  ratio {hsm/max(msm,1e-9):.2f}")
    print()

# Outcome balance: does the gate change the probability the turn completes?
all_hit = [r for r in rows if clause_count(r["prompt"]) > 0]
all_miss = [r for r in rows if clause_count(r["prompt"]) == 0]
for name, grp in (("hit", all_hit), ("miss", all_miss)):
    if not grp:
        continue
    ok = sum(1 for r in grp if r["outcome"] == "completed")
    print(f"{name} turns: {ok}/{len(grp)} completed = {100*ok/len(grp):.0f}%")
