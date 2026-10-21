"""Discriminative power of the trigger vs trivial baselines.

The rule asserts a clause hit identifies a task worth expert reconstruction. That is a
binary classifier claim, so it can be scored like one. Criterion: did the turn consume
an above-median amount of work (steps), among turns that completed normally.

Reports AUC for:
  - the shipped rule (any clause hit)
  - message length >= 150 chars (a one-parameter baseline)
  - "contains any of the 4 verbs" (clause b alone)
  - the count of clauses hit

If the rule's AUC is near 0.5, it is not a classifier at all — it is a coin flip with
four named reasons attached.

    python .tmp/auc.py
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
    in_turn = False
    outcome = None

    def close():
        if in_turn and prompt is not None:
            rows.append({"prompt": prompt, "steps": steps, "outcome": outcome})

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
            prompt, steps, in_turn, outcome = None, 0, True, None
        elif not in_turn:
            continue
        elif t == "step/start":
            steps += 1
        elif t == "user/message":
            if (d.get("source") or {}).get("kind") != "user":
                continue
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
            if body and prompt is None:
                prompt = body
        elif t == "turn/end":
            outcome = (d.get("reason") or {}).get("kind")
            close()
            in_turn = False
    close()

# Criterion: completed turns only, positive label = above-median step count.
done = [r for r in rows if r["outcome"] == "completed"]
med = statistics.median(r["steps"] for r in done)
data = [r for r in done if r["steps"] != med]
labels = [r["steps"] > med for r in data]


def auc(scores, labels) -> float:
    """Rank-based AUC (Mann-Whitney U)."""
    pairs = sorted(zip(scores, labels))
    pos = sum(labels)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return float("nan")
    rank_sum = 0.0
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j) / 2 + 1
        for k in range(i, j + 1):
            if pairs[k][1]:
                rank_sum += avg_rank
        i = j + 1
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


predictors = {
    "shipped rule (any clause)": [1.0 if clause_count(r["prompt"]) > 0 else 0.0 for r in data],
    "clause count (0-4)": [float(clause_count(r["prompt"])) for r in data],
    "clause (b) verbs only": [1.0 if any(v in r["prompt"] for v in VERBS) else 0.0 for r in data],
    "length >= 150 chars": [1.0 if len(r["prompt"]) >= 150 else 0.0 for r in data],
    "length (continuous)": [float(len(r["prompt"])) for r in data],
}

print(f"completed turns: {len(done)}, used (excluding median tie): {len(data)}")
print(f"positive class = steps > {med:.0f}\n")
print(f"{'predictor':<28} {'AUC':>7}")
for name, scores in predictors.items():
    print(f"{name:<28} {auc(scores, labels):>7.3f}")

print("""
AUC 0.5 = no information. 0.7 = usable. 0.8+ = strong.
A rule whose AUC sits at 0.5 fires for reasons unrelated to the quantity it claims
to be measuring, no matter how good its curated examples look.""")
