"""Verify the dsh-depth-elevation plugin end to end.

Replaces the hook-era verifier: the enforcement moved from a subprocess hook
(~1.1s per turn) to a native plugin, so the checks moved with it.

Four layers:
  1. package    — every file the bundle needs is present
  2. suites     — decide + apply + e2e (node test/all.mjs)
  3. mount      — the desktop profile composes the plugin row and resolves it
  4. retire     — the superseded hook config is not still mounted

    python tools/verify_elevation_plugin.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(HERE)

# Verify the source you are editing, not a copy: the runtime location is a
# junction back to this repo, so checking the repo checks what runs.
PLUGIN = WORKSPACE
RUNTIME = os.path.expanduser(r"~\.dsh\plugins\dsh-depth-elevation")
DESKTOP = os.path.expanduser(r"~\.dsh\profiles\desktop")
HOOKS = os.path.expanduser(r"~\.dsh\hooks")
ELECTRON = r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
BOOT = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
        r"\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js")
ANCHOR = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
          r"\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json")


def check_package() -> bool:
    required = ["package.json", "cordis.patch.yml", "lib/index.js", "lib/decide.js",
                "test/all.mjs", "README.md"]
    missing = [f for f in required if not os.path.exists(os.path.join(PLUGIN, f))]
    if missing:
        print(f"FAIL  package  missing {', '.join(missing)}")
        return False
    manifest = json.load(open(os.path.join(PLUGIN, "package.json"), encoding="utf-8"))
    if not manifest.get("dsh", {}).get("bundle"):
        print("FAIL  package  package.json declares no dsh.bundle")
        return False
    print(f"PASS  package  {len(required)} artifacts, dsh.bundle declared")
    return True


def check_suites() -> bool:
    r = subprocess.run(["node", "test/all.mjs"], cwd=PLUGIN,
                       capture_output=True, text=True, encoding="utf-8")
    ok = r.returncode == 0
    for line in (r.stdout or "").split("\n"):
        if line.startswith(("PASS", "FAIL", "all ")):
            print(f"{'' if ok else ''}{line}")
    if not ok and r.stderr:
        print(f"FAIL  suites   {r.stderr.splitlines()[0]}")
    return ok


def check_mount() -> bool:
    script = f"""
    const m = require({json.dumps(BOOT)});
    (async () => {{
      const prof = m.loadProfileDirectory('dsh', {json.dumps(DESKTOP)}, {json.dumps(ANCHOR)}, {{}});
      const composed = JSON.stringify(prof);
      const res = await m.createRuntimeResolution({{ installAnchor: {json.dumps(ANCHOR)}, profile: prof }});
      const linked = (res.linkedRoots || []).map((r) => r.name);
      console.log(JSON.stringify({{
        row: composed.includes('depth-elevation'),
        hookRow: composed.includes('hooks-claude-code'),
        linked: linked.includes('dsh-depth-elevation'),
        layers: prof.layers?.length ?? 0,
      }}));
    }})().catch((e) => console.log(JSON.stringify({{ error: String(e.message).slice(0, 200) }})));
    """
    env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
    r = subprocess.run([ELECTRON, "-e", script], capture_output=True, text=True,
                       encoding="utf-8", env=env)
    raw = (r.stdout or "").strip().split("\n")[-1] if r.stdout else "{}"
    try:
        info = json.loads(raw)
    except ValueError:
        print(f"FAIL  mount    unparseable: {raw[:120]}")
        return False
    if "error" in info:
        print(f"FAIL  mount    {info['error']}")
        return False
    ok = bool(info.get("row")) and bool(info.get("linked"))
    print(f"{'PASS' if ok else 'FAIL'}  mount    row={info.get('row')} "
          f"resolved={info.get('linked')} layers={info.get('layers')}")
    return ok


def check_retire() -> bool:
    """The hook bridge must not still be mounted: two gates would double-ask."""
    live = os.path.join(HOOKS, "hooks.json")
    if os.path.exists(live):
        print("FAIL  retire   hook config still live — it would gate in parallel with the plugin")
        return False
    desktop_patch = open(os.path.join(DESKTOP, "cordis.patch.yml"), encoding="utf-8").read()
    if "hooks-claude-code" in desktop_patch:
        print("FAIL  retire   desktop patch still mounts hooks-claude-code")
        return False
    print("PASS  retire   hook bridge unmounted, no double gate")
    return True


def check_workspace_is_source() -> bool:
    """Editing this workspace must change what runs.

    The whole point of the migration: the runtime location is a junction back
    here. If it is a real directory (a copy), edits silently stop taking effect —
    the worst kind of failure, because everything still looks healthy.
    """
    if not os.path.exists(RUNTIME):
        print(f"FAIL  source   runtime location missing: {RUNTIME}")
        return False
    run_real = os.path.realpath(RUNTIME)
    src_real = os.path.realpath(PLUGIN)
    if os.path.normcase(run_real) != os.path.normcase(src_real):
        print(f"FAIL  source   runtime is not this workspace\n"
              f"                runtime -> {run_real}\n                workspace -> {src_real}")
        return False
    # A marker file proves liveness rather than just path equality.
    marker = os.path.join(PLUGIN, ".workspace-marker")
    probe = os.path.join(RUNTIME, ".workspace-marker")
    try:
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("workspace\n")
        visible = os.path.exists(probe)
    finally:
        for path in (marker, probe):
            try:
                os.remove(path)
            except OSError:
                pass
    if not visible:
        print("FAIL  source   file written in workspace is not visible at runtime path")
        return False
    print("PASS  source   runtime path is a live junction to this workspace")
    return True


def main() -> int:
    results = [check_package(), check_suites(), check_mount(), check_workspace_is_source(), check_retire()]
    print()
    if all(results):
        print("PASS: workspace is the live source, plugin is mounted and tested, old hook retired")
        return 0
    print(f"FAIL: {results.count(False)} of {len(results)} layers failed")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
