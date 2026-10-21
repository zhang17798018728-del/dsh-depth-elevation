"""Is the trigger's own claim falsifiable, and what would falsify it?

The rule is written as a hard predicate ("命中任一条即必须触发") with no precision
target, no sample, and no overturn condition. This measures the one thing that can be
measured without asking the author: how many times the rule would have to be wrong to
count as a failure, and whether the corpus supplies that many observations.

Also: does the rule ever self-terminate? OFFER_MARK makes the instruction text itself
suppress future gates, so the rule's evidence base can be contaminated by its own
output.

    python .tmp/triggers.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

VERBS = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构', '排查', '评估',
         '报告', '课件', '教学', '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化',
         '诊断', '材料', '创建', '开发', '实现', '做一个', '写成', '整成']

# Clause (a) and (c) pattern checks, mirroring lib/decide.js
import re
PATH = re.compile(r"[A-Za-z]:\\|\b[\w-]{1,64}\.(?:py|md|xlsx|docx|json|html|ts|js|csv)\b")
LINK = re.compile(r"https?://")

clause_hits = Counter()
n = 0
multi = 0

for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") != "user/message":
            continue
        d = rec.get("data") or {}
        if (d.get("source") or {}).get("kind") != "user":
            continue
        t = "".join(p.get("text", "") for p in (d.get("content") or [])
                    if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
        if not t:
            continue
        n += 1
        hits = []
        if PATH.search(t) or "```" in t or "\t" in t or t.count("|") >= 4:
            hits.append("a")
        if any(v in t for v in VERBS):
            hits.append("b")
        if len(t) >= 150 or LINK.search(t):
            hits.append("c")
        if any(k in t for k in ("给我", "帮我", "生成", "输出", "整理成", "做成")):
            hits.append("d")
        for h in hits:
            clause_hits[h] += 1
        if len(hits) > 1:
            multi += 1

print(f"human-sourced messages: {n}")
print(f"messages hitting >1 clause: {multi} ({100*multi/n:.0f}%)")
print("\nclause hit counts (a message can hit several):")
for c in "abcd":
    print(f"  ({c}): {clause_hits[c]:4d}  = {100*clause_hits[c]/n:.1f}% of messages")

union = 0
# recompute union properly
union = 0
for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") != "user/message":
            continue
        d = rec.get("data") or {}
        if (d.get("source") or {}).get("kind") != "user":
            continue
        t = "".join(p.get("text", "") for p in (d.get("content") or [])
                    if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
        if not t:
            continue
        if (PATH.search(t) or "```" in t or "\t" in t or t.count("|") >= 4
                or any(v in t for v in VERBS) or len(t) >= 150 or LINK.search(t)
                or any(k in t for k in ("给我", "帮我", "生成", "输出", "整理成", "做成"))):
            union += 1

print(f"\nclause set union (a or b or c or d): {union}/{n} = {100*union/n:.1f}%")
print(f"after the minChars/exemptPrefix exemptions shrink it to roughly the gate rate measured earlier.")
