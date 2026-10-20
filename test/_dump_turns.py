"""Dump every real user turn from the dsh session transcripts as JSON.

Node cannot read these files: they are multi-frame zstd, and zlib's
decompressSync/createZstdDecompress stop at the first frame (the header line).
Python's compression.zstd handles the whole stream, so the Node test shells out
to this script instead of pretending the file is readable.

Rows are filtered to real human turns only (subagent sessions carry a task
prompt, not a user turn).

    python _dump_turns.py
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

from compression import zstd

SESSIONS = os.path.expanduser("~/.dsh/sessions/*/*/session.v4.jsonl.zstd")


def main() -> int:
    rows = []
    matched = 0
    unreadable = []
    for path in glob.glob(SESSIONS):
        matched += 1
        try:
            raw = zstd.decompress(open(path, "rb").read()).decode("utf-8", errors="replace")
        except Exception as exc:                       # noqa: BLE001 - report, do not hide
            # An unreadable transcript must be surfaced: silently skipping it
            # would turn a broken corpus into "no corpus", which the test treats
            # as a legitimate skip on CI.
            unreadable.append(f"{os.path.basename(os.path.dirname(path))}: {exc}")
            continue
        sid = os.path.basename(os.path.dirname(path))
        depth = 0
        for line in raw.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("type") == "session":
                depth = rec.get("delegationDepth") or 0
                continue
            if depth or rec.get("type") != "user/message":
                continue
            data = rec.get("data") or {}
            content = data.get("content")
            if isinstance(content, str):
                body = content
            elif isinstance(content, list):
                body = "\n".join(p.get("text", "") for p in content
                                 if isinstance(p, dict) and isinstance(p.get("text"), str))
            else:
                continue
            for pat in (r"<system-reminder>.*?</system-reminder>",
                        r"<hindsight_knowledge_refresh>.*?</hindsight_knowledge_refresh>",
                        r"<hindsight_knowledge>.*?</hindsight_knowledge>",
                        r"<available_skills>.*?</available_skills>"):
                body = re.sub(pat, "", body, flags=re.S)
            body = body.strip()
            if not body:
                continue
            rows.append({"at": rec.get("time") or 0, "sid": sid, "body": body})

    # Force UTF-8 on stdout: the console default (gbk on this machine) cannot
    # encode emoji in the prompts, and a partial write would corrupt the JSON.
    sys.stdout.reconfigure(encoding="utf-8")

    if matched and len(unreadable) == matched:
        # Every transcript present was unreadable: exit non-zero so the caller
        # reports a failure instead of concluding there is no corpus.
        print(f"all {matched} transcripts unreadable; first: {unreadable[0]}", file=sys.stderr)
        return 1
    if unreadable:
        print(f"warning: {len(unreadable)}/{matched} transcripts unreadable: {unreadable[0]}",
              file=sys.stderr)

    json.dump(rows, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
