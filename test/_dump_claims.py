"""Reconstruct the exact `messages` array production hands to agent/pre-step.

Why this exists: `test/decide.test.mjs` used to replay the *human's* text. Production
does not receive that — `preStep` passes `this.inbox.claim(target, turn)`, which is
the inbox queue, not the transcript. A replay on the wrong input measures the wrong
thing.

Ground truth, from `@deepseek-ai/dsh-agent-loop/lib/index.js`:

    claim(target, turn)  -> mutate("next-step", 0, n, [], false)
                            mutate("next-turn", 0, 1, [], false)
    remove/clear/splice  -> mutate(..., true)

`mutate` stamps `outcome: "canceled"` only when `discardRemoved` is true. So in the
durable log a `agent/inbox/spliced` record with `removedCount` and NO `outcome` is a
claim, and one WITH `outcome` is a removal. That is the discriminator used below; the
shadow inbox starts empty and is advanced only by the recorded events.

Output: one JSON row per claimed batch carrying the messages in the shape `apply()`
expects, plus whether a gate actually fired on it.

Two reconstructions that look obvious and are both wrong:

  1. `agent/inbox/spliced` with `removedCount` but no `outcome` is a claim; one WITH
     `outcome: "canceled"` is a removal. (`mutate` sets `outcome` only when
     `discardRemoved` is true.)
  2. One `claim()` emits TWO splices when `target === "next-turn"`: it drains
     `next-step` first, then takes one `next-turn`. They are the SAME batch and must be
     merged. Splitting them manufactured a phantom batch whose text was only the queued
     prompt without its queued notice — which the replay then read as a gate that
     should have fired and did not.

    python test/_dump_claims.py            # JSON to stdout
    python test/_dump_claims.py --stats    # summary only
"""

from __future__ import annotations

import glob
import json
import os
import sys

from compression import zstd

GATE_MARK = "[depth-elevation gate]"
SESSIONS = os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")


def message_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part["text"] for part in content
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    )


def compact(message: dict) -> dict:
    """Keep only what apply() reads, so the JSON stays small."""
    return {
        "role": message.get("role") or "user",
        "content": [{"type": "text", "text": message_text(message)}],
        "source": {"kind": (message.get("source") or {}).get("kind")},
    }


def claimed_batches(path: str) -> list[dict]:
    """Every claimed batch in one transcript, in claim order."""
    try:
        raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", "replace")
    except Exception:
        return []

    sid = os.path.basename(os.path.dirname(path))
    # Sessions live at ~/.dsh/sessions/<profile>/<session>/session.v4.jsonl.zstd, so
    # the profile name is the grandparent directory. It matters because a profile that
    # never mounted the plugin cannot have fired, and a replay that ignores that reads
    # deployment history as false positives.
    profile = os.path.basename(os.path.dirname(os.path.dirname(path)))
    depth = 0
    turn = 0
    inbox = {"next-turn": [], "next-step": []}
    batches: list[dict] = []

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        kind = rec.get("type")
        data = rec.get("data") or {}

        if kind == "session":
            depth = rec.get("delegationDepth") or 0
            continue
        if kind == "turn/start":
            turn = data.get("turn") or turn + 1
            continue

        if kind == "agent/inbox/spliced":
            target = data.get("target")
            if target not in inbox:
                continue
            start = data.get("start") or 0
            removed = data.get("removedCount") or 0
            taken = inbox[target][start:start + removed]
            inbox[target][start:start + removed] = data.get("inserted") or []
            if removed and "outcome" not in data:
                entry = {
                    "sid": sid,
                    "profile": profile,
                    "depth": depth,
                    "turn": turn,
                    "target": target,
                    "messages": [compact(m) for m in taken],
                    "at": rec.get("time") or 0,
                    "fired": False,
                    "gateSource": None,
                }
                # `claim(target, turn)` is ONE call but TWO durable splices:
                #   mutate("next-step", 0, n) then mutate("next-turn", 0, 1) when
                #   target === "next-turn". Both are attributed to the same step.
                # Merging them into the earlier record is what makes the replay see
                # the batch `preStep` actually passed — splitting them was a bug that
                # produced a phantom "unexplained miss".
                merged_into = batches[-1] if (
                    target == "next-turn"
                    and batches
                    and batches[-1]["turn"] == turn
                    and batches[-1]["target"] == "next-step"
                    and not batches[-1]["fired"]
                ) else None
                if merged_into is not None:
                    merged_into["messages"].extend(entry["messages"])
                    merged_into["target"] = "next-turn"
                else:
                    batches.append(entry)
            continue

        if kind == "user/message" and message_text(data).startswith(GATE_MARK):
            # The gate is appended to the step it gated: attach it to this turn's
            # most recent claim.
            for batch in reversed(batches):
                if batch["turn"] == turn:
                    batch["fired"] = True
                    batch["gateSource"] = (data.get("source") or {}).get("kind")
                    break

    return batches


def main() -> int:
    rows: list[dict] = []
    sessions = 0
    for path in sorted(glob.glob(SESSIONS)):
        found = claimed_batches(path)
        if found:
            sessions += 1
        rows.extend(found)

    # Force UTF-8 before printing anything. Windows defaults stdout to the console code
    # page (cp1252 on a runner), and both branches here emit non-ASCII — CJK source-kind
    # names in --stats, and CJK message bodies in the JSON. Doing it only on the JSON
    # path left --stats one Chinese source name away from a UnicodeEncodeError.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    if "--stats" in sys.argv:
        fired = [r for r in rows if r["fired"]]
        sources: dict[str, int] = {}
        for row in rows:
            for message in row["messages"]:
                key = message["source"]["kind"]
                sources[key] = sources.get(key, 0) + 1
        print(f"sessions with claims : {sessions}")
        print(f"claimed batches      : {len(rows)}")
        print(f"  gates fired on them: {len(fired)}")
        print(f"  subagent (depth>0) : {sum(1 for r in rows if r['depth'] > 0)}")
        print("  claimed message sources:")
        for key, count in sorted(sources.items(), key=lambda kv: -kv[1]):
            print(f"    {count:5d}  {key}")
        return 0

    json.dump(rows, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
