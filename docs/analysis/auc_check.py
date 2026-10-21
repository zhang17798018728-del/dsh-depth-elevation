"""Sanity-check the AUC implementation before trusting the headline number.

A wrong rank formula would make "the rule is worthless" a measurement artefact. Test
against known cases:
  perfect predictor -> 1.0
  inverted          -> 0.0
  constant          -> 0.5
  known small case  -> 0.833

Then re-run the shipped rule with the gate's own overhead removed, since the offer
adds an ask_user_question round trip (+2 steps) to every gated turn. If gated turns
are equal DESPITE that overhead, the underlying tasks are shorter than they look.

    python .tmp\\auc_check.py
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


def auc(scores, labels) -> float:
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


print("=== implementation check ===")
print(f"perfect   : {auc([1,2,3,4], [False,False,True,True]):.3f}  expect 1.000")
print(f"inverted  : {auc([4,3,2,1], [False,False,True,True]):.3f}  expect 0.000")
print(f"constant  : {auc([1,1,1,1], [False,False,True,True]):.3f}  expect 0.500")
# [1,2,2,3] with positives at idx 1 and 3. Pairwise: pos(2) vs neg(1) win,
# pos(2) vs neg(2) tie=0.5, pos(3) vs neg(1) win, pos(3) vs neg(2) win -> 3.5/4.
print(f"tie-heavy : {auc([1,2,2,3], [False,True,False,True]):.3f}  expect 0.875")
print()

# ---- rebuild turns -----------------------------------------------------------
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


GATE = "[depth-elevation gate]"
rows = []
for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    depth = 0
    prompt = None
    steps = 0
    gated = False
    in_turn = False
    outcome = None

    def close():
        if in_turn and prompt is not None:
            rows.append({"prompt": prompt, "steps": steps, "gated": gated, "outcome": outcome})

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
            prompt, steps, gated, in_turn, outcome = None, 0, False, True, None
        elif not in_turn:
            continue
        elif t == "step/start":
            steps += 1
        elif t == "user/message":
            src = (d.get("source") or {}).get("kind")
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
            if body.startswith(GATE):
                gated = True
            elif src == "user" and body and prompt is None:
                prompt = body
        elif t == "turn/end":
            outcome = (d.get("reason") or {}).get("kind")
            close()
            in_turn = False
    close()

done = [r for r in rows if r["outcome"] == "completed" and r["prompt"]]
print(f"completed turns with a human prompt: {len(done)}")
print(f"  gated: {sum(1 for r in done if r['gated'])}, not gated: {sum(1 for r in done if not r['gated'])}")

# AUC with steps, and again with the gate's round trips subtracted from gated turns
for label, adjust in (("raw steps", 0), ("gate overhead removed (-2)", 2)):
    data = [r for r in done]
    scores = [float(r["steps"] - (adjust if r["gated"] else 0)) for r in data]
    med = statistics.median(scores)
    keep = [(s, r) for s, r in zip(scores, data) if s != med]
    sc = [k[0] for k in keep]
    lab = [k[0] > med for k in keep]
    which = [1.0 if clause_count(k[1]["prompt"]) > 0 else 0.0 for k in keep]
    print(f"\n{label}: AUC(rule -> long turn) = {auc(which, lab):.3f}  (n={len(keep)})")
    print(f"  actual gate variable: AUC(gated -> long turn) = {auc([1.0 if k[1]['gated'] else 0.0 for k in keep], lab):.3f}")
