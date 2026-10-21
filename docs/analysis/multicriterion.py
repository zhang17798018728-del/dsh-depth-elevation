"""Does the trigger predict ANY other operationalisation of "depth"?

The previous test used step count as the criterion and got AUC 0.509. Before
concluding "the rule measures nothing", test the alternatives a defender would raise:
maybe depth is not turn length. Four candidate criteria:

  C1 work volume   - steps in the turn          (done: AUC 0.509)
  C2 deliverable   - did the turn write a file / produce an artifact
  C3 iteration     - how many follow-up human messages the task needed
  C4 duration      - wall-clock seconds of the turn

Report AUC for each. A rule can be a legitimate classifier of one and useless for
another; the honest claim is per-criterion.

    python .tmp\multicriterion.py
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
WRITE_TOOLS = {"write", "edit", "ops_write", "ops_edit"}


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


sessions = []
for path in glob.glob(os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")):
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        continue
    depth = 0
    turns = []
    cur = None
    wrote = False
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
            if cur:
                turns.append(cur)
            cur = {"prompt": None, "steps": 0, "calls": 0, "wrote": False,
                   "t0": rec.get("time") or 0, "t1": rec.get("time") or 0, "outcome": None}
        elif cur is None:
            continue
        elif t == "step/start":
            cur["steps"] += 1
        elif t == "user/message":
            if (d.get("source") or {}).get("kind") != "user":
                continue
            body = "".join(p.get("text", "") for p in (d.get("content") or [])
                           if isinstance(p, dict) and isinstance(p.get("text"), str)).strip()
            if body and cur["prompt"] is None:
                cur["prompt"] = body
        elif t == "assistant/message":
            msg = d.get("message") or {}
            for b in (msg.get("content") or []):
                if isinstance(b, dict) and b.get("type") == "tool-call":
                    cur["calls"] += 1
                    if b.get("name") in WRITE_TOOLS:
                        cur["wrote"] = True
        elif t == "turn/end":
            cur["outcome"] = (d.get("reason") or {}).get("kind")
            cur["t1"] = rec.get("time") or cur["t0"]
    if cur:
        turns.append(cur)
    sessions.append(turns)


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


flat = [t for s in sessions for t in s if t["prompt"]]
print(f"turns: {len(flat)}\n")

# C1 steps (completed only)
done = [t for t in flat if t["outcome"] == "completed"]
med = statistics.median(t["steps"] for t in done)
c1 = [t for t in done if t["steps"] != med]
print(f"C1 work volume  : AUC {auc([1.0 if clause_count(t['prompt']) > 0 else 0.0 for t in c1], [t['steps'] > med for t in c1]):.3f}  (n={len(c1)})")

# C2 deliverable
wrote = [t for t in done if t["wrote"]]
nowrite = [t for t in done if not t["wrote"]]
print(f"C2 deliverable  : hit rate {sum(1 for t in wrote if clause_count(t['prompt'])>0)}/{len(wrote)} wrote a file, "
      f"{sum(1 for t in nowrite if clause_count(t['prompt'])>0)}/{len(nowrite)} did not")

# C3 iteration: follow-up human messages in the same session after this turn
for turns in sessions:
    for i, t in enumerate(turns):
        t["followups"] = sum(1 for u in turns[i + 1:] if u["prompt"])
iter_turns = [t for t in done if t["followups"] != statistics.median(x["followups"] for x in done)]
medf = statistics.median(x["followups"] for x in done)
print(f"C3 iteration    : AUC {auc([1.0 if clause_count(t['prompt']) > 0 else 0.0 for t in iter_turns], [t['followups'] > medf for t in iter_turns]):.3f}  (n={len(iter_turns)})")

# C4 duration
dur = [t for t in done if t["t1"] > t["t0"]]
medd = statistics.median(t["t1"] - t["t0"] for t in dur)
d2 = [t for t in dur if (t["t1"] - t["t0"]) != medd]
print(f"C4 duration     : AUC {auc([1.0 if clause_count(t['prompt']) > 0 else 0.0 for t in d2], [(t['t1']-t['t0']) > medd for t in d2]):.3f}  (n={len(d2)})")

print("""
Each row is the same rule scored against a different definition of "depth".
AUC 0.5 = coin flip. If every criterion lands near 0.5, the rule is not measuring
depth under any of the four definitions a defender would offer.""")
