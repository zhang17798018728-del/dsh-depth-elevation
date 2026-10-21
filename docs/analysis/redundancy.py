"""Are the four clauses independent evidence, or one signal counted four times?

A well-formed decision rule uses clauses that each add information. If a message that
hits (b) also hits (c) and (d) most of the time, the rule has three aliases for one
phone book, and its stated precision is illusory: you cannot raise confidence by
agreeing with yourself.

Marginal analysis over every human-sourced message:
  - single-clause hits (a clause that fires alone)
  - overlap matrix
  - how much each clause adds beyond the others

    python .tmp/redundancy.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import Counter
from itertools import combinations

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

VERBS = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构', '排查', '评估',
         '报告', '课件', '教学', '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化',
         '诊断', '材料', '创建', '开发', '实现', '做一个', '写成', '整成']
PATH = re.compile(r"[A-Za-z]:\\|\b[\w-]{1,64}\.(?:py|md|xlsx|docx|json|html|ts|js|csv)\b")
LINK = re.compile(r"https?://")

messages = []
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
        if t:
            messages.append(t)


def clauses(t: str) -> set[str]:
    hit = set()
    if PATH.search(t) or "```" in t or "\t" in t or t.count("|") >= 4:
        hit.add("a")
    if any(v in t for v in VERBS):
        hit.add("b")
    if len(t) >= 150 or LINK.search(t):
        hit.add("c")
    if any(k in t for k in ("给我", "帮我", "生成", "输出", "整理成", "做成")):
        hit.add("d")
    return hit


n = len(messages)
sets = [clauses(t) for t in messages]
any_hit = [s for s in sets if s]

print(f"human messages: {n}, hitting at least one clause: {len(any_hit)} ({100*len(any_hit)/n:.1f}%)")
print()
print("single-clause hits (that clause fired alone):")
alone = Counter()
for s in sets:
    if len(s) == 1:
        alone[next(iter(s))] += 1
for c in "abcd":
    print(f"  ({c}) alone: {alone[c]:4d}")

print()
print("pairwise co-occurrence (rows are clauses, cells are messages where both fired):")
present = Counter()
for s in sets:
    for c in s:
        present[c] += 1
print(f"{'':4}" + "".join(f"{c:>8}" for c in "abcd"))
for a in "abcd":
    cells = []
    for b in "abcd":
        if a == b:
            cells.append(f"{present[a]:>8}")
        else:
            both = sum(1 for s in sets if a in s and b in s)
            cells.append(f"{both:>8}")
    print(f"({a}) " + "".join(cells))

print()
print("conditional probability P(x | b) — how often a b-hit also hits x:")
b_hits = [s for s in sets if "b" in s]
for x in "acd":
    both = sum(1 for s in b_hits if x in s)
    print(f"  P({x} | b) = {both}/{len(b_hits)} = {100*both/max(len(b_hits),1):.0f}%")

print()
print("marginal contribution: messages each clause is the ONLY one to catch:")
for c in "abcd":
    only = sum(1 for s in sets if s == {c})
    print(f"  ({c}) unique catch: {only}/{len(any_hit)} = {100*only/max(len(any_hit),1):.1f}% of gated")
