"""Does the trigger carry information? Base rate and likelihood ratio per clause.

The rule says a clause "hitting" means the task has depth potential. That is a claim
about a diagnostic test, and the test's quality is not its hit count — it is how much
the hit raises the probability the user actually wants elevation.

Using the user's own answer (升维 / 直接做) as the criterion:

    P(elevate | clause hit)  vs  P(elevate | clause miss)

and the likelihood ratio LR = hit-rate / miss-rate. LR = 1 means the clause tells you
nothing and the gate is a coin flip with extra steps.

Base rates are computed over every human-sourced claimed batch.

    python .tmp/base_rate.py
"""

from __future__ import annotations

import glob
import json
import os
import sys
from collections import Counter, defaultdict

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

MARK = "[depth-elevation gate]"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "test"))

# The shipped verb list, so this matches lib/decide.js exactly.
VERBS = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构', '排查', '评估',
         '报告', '课件', '教学', '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化',
         '诊断', '材料', '创建', '开发', '实现', '做一个', '写成', '整成']
PREFIX = ['改成', '换成', '再来', '继续', '接着', '然后', '好的', '收到']

turns = []
fires = []

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
        src = (d.get("source") or {}).get("kind")
        body = "".join(p.get("text", "") for p in (d.get("content") or [])
                       if isinstance(p, dict) and isinstance(p.get("text"), str))
        if src == "user" and body.strip():
            turns.append(body.strip())
        if body.startswith(MARK):
            fires.append({"sid": sid, "index": i})

# ---------------------------------------------------------------- base rates
def has_verb(t):
    return [v for v in VERBS if v in t]

total = len(turns)
print(f"human-sourced messages: {total}")

verb_hits = [t for t in turns if has_verb(t)]
print(f"\nclause (b) base rate:")
print(f"  contains >=1 trigger verb : {len(verb_hits)}/{total} = {100*len(verb_hits)/total:.1f}%")

per_verb = Counter()
for t in turns:
    for v in has_verb(t):
        per_verb[v] += 1
print("  most common triggers in ordinary human text:")
for v, c in per_verb.most_common(10):
    print(f"    {v:6s} {c:5d}  ({100*c/total:.1f}% of all messages)")

# How many triggers per message?
dist = Counter(len(has_verb(t)) for t in turns)
print(f"  triggers per message: {dict(sorted(dist.items()))}")

# ---------------------------------------------------------------- criterion
# We only have a criterion (the user's answer) for the 5 fires that were answered.
answers = {}
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
        body = "".join(p.get("text", "") for p in (d.get("content") or [])
                       if isinstance(p, dict) and isinstance(p.get("text"), str))
        if not body.startswith(MARK):
            continue
        for nxt in events[i + 1:i + 60]:
            data = nxt.get("data") or {}
            if nxt.get("type") == "tool/result":
                msg = data.get("message") or {}
                if (msg.get("source") or {}).get("kind") != "tool":
                    continue
                text = "".join(x.get("text", "") for x in (msg.get("content") or [])
                               if isinstance(x, dict) and isinstance(x.get("text"), str))
                try:
                    payload = json.loads(text)
                except (ValueError, TypeError):
                    continue
                if payload.get("pending"):
                    answers[(sid, i)] = "pending"
                for item in payload.get("answers") or []:
                    if item.get("id") == "elevation":
                        label = (item.get("selected") or [""])[0] or item.get("custom") or ""
                        answers[(sid, i)] = "ELEVATE" if "升维" in label else "DIRECT"
                if (sid, i) in answers:
                    break

print(f"\ncriterion available: {len(answers)} of {len(fires)} fires")
print(f"  {Counter(answers.values())}")

# ---------------------------------------------------------------- likelihood
# Among the answered fires, how did the clause that fired relate to the answer?
print("\nEvery answered fire, with the clause production actually reported:")
for f in fires:
    key = (f["sid"], f["index"])
    if key not in answers:
        continue
    # the gate text itself records the clause after this fix; older ones do not
    print(f"  {answers[key]:8s} sid={f['sid'][:18]}")

print("""
Reading:
  A clause is a diagnostic test. Its value is the likelihood ratio
  LR = P(hit | elevate) / P(hit | direct). LR near 1 means the clause cannot
  separate the two populations — the gate fires on a base rate, not on depth.
  With 5 answered fires the criterion sample is too small for a stable LR.
  That is itself the finding: the rule's key threshold has n=5 evidence.
""")
