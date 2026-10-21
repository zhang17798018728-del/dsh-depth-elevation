"""Internal consistency of the rule as written.

A decision rule has three parts that must agree: the trigger, the exemptions, and the
claim it makes about itself. This checks the ones that are checkable.

  I1  Does the verb list match the verbs the rule text names?
  I2  Is the exemption set disjoint from the trigger set?
  I3  Do the "hard predicate" clauses overlap? (a hit on two clauses is not twice the
      evidence, and the rule never says what to do with 0 or with 3)
  I4  Does the rule define a false-positive budget, sample size, or overturn condition?
  I5  Is the offer's own text re-gated by OFFER_MARK, i.e. does the rule suppress its
      own evidence?

    python .tmp/consistency.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

from compression import zstd

sys.stdout.reconfigure(encoding="utf-8")

# ---- I1: the rule text vs the shipped list ------------------------------------
RULE_TEXT_VERBS = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构',
                   '排查', '评估', '报告', '课件', '教学']
SHIPPED = ['设计', '方案', '分析', '规划', '搭建', '做一套', '写一套', '重构', '排查', '评估',
           '报告', '课件', '教学', '汇报', '梳理', '汇总', '整理', '编写', '制定', '优化',
           '诊断', '材料', '创建', '开发', '实现', '做一个', '写成', '整成']
added = [v for v in SHIPPED if v not in RULE_TEXT_VERBS]
print(f"I1 verb list: rule text names {len(RULE_TEXT_VERBS)}, shipped code has {len(SHIPPED)}")
print(f"   {len(added)} verbs the rule text does not contain: {added}")
print(f"   -> the code enforces a broader rule than the document. Not a bug, but the")
print(f"      document is what the user consented to.")

# ---- I2: exemption vs trigger disjointness -----------------------------------
EXEMPT_PREFIX = ['改成', '换成', '再来', '继续', '接着', '然后', '好的', '收到']
EXEMPT_EXACT_TEXT = ['继续', '好', '是', '可以', '行', 'ok', 'OK', '嗯', '对', 'a', '1']
overlap_verb = [e for e in EXEMPT_EXACT_TEXT if any(v in e for v in SHIPPED)]
overlap_pref = [e for e in EXEMPT_PREFIX if any(v in e for v in SHIPPED)]
print(f"\nI2 exemption vs trigger overlap:")
print(f"   exact ack entries that contain a trigger verb: {overlap_verb or 'none'}")
print(f"   prefix entries that contain a trigger verb: {overlap_pref or 'none'}")

# ---- I3: the rule never states a combination policy --------------------------
print(f"\nI3 combination policy: the rule says 'any clause => must trigger'.")
print(f"   It does not state: whether 0 clauses for a clearly-large task is a miss,")
print(f"   whether 4 clauses is stronger evidence than 1, or what a conflicting")
print(f"   signal (long material but explicit 'just give me the file') should do.")

# ---- I4: falsifiability ------------------------------------------------------
print(f"\nI4 falsifiability:")
print(f"   precision target          : none stated")
print(f"   acceptable false-positive : '宁可多弹一次，不可静默跳过' (unbounded)")
print(f"   required sample size      : none stated")
print(f"   overturn condition        : none stated")
print(f"   -> as written, no observation can show the rule is wrong. A rule that no")
print(f"      evidence can falsify is not a hard predicate, it is a preference.")

# ---- I5: does OFFER_MARK contaminate the evidence base? ----------------------
MARK = "顶尖专家深度与野心"
GATE = "[depth-elevation gate]"
turns_with_mark = 0
turns_total = 0
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
        body = "".join(p.get("text", "") for p in (d.get("content") or [])
                       if isinstance(p, dict) and isinstance(p.get("text"), str))
        if not body.strip():
            continue
        turns_total += 1
        if MARK in body or GATE in body:
            turns_with_mark += 1

print(f"\nI5 self-suppression: {turns_with_mark} of {turns_total} human messages contain the")
print(f"   OFFER_MARK text. Those are excluded by design, so any analysis that counts")
print(f"   'how often the gate should have fired' is biased by the gate's own output.")
print(f"   In this corpus the contamination is {100*turns_with_mark/max(turns_total,1):.0f}%.")
