"""Repair the profile-level symlinks that point at a deleted install.

`~/.dsh/profiles/node_modules` holds ~550 symlinks into the previous Electron
install (`E:\\dsh\\DSH Desktop\\...`). That directory no longer exists, so every
one of them is broken — which means plugins mounted under a profile cannot
resolve their `@deepseek-ai/*` peers, because Node's lookup walk hits a dead link
and stops.

Two target sets exist now:
  * packages that live inside the new install's app.asar (readable only by
    Electron's patched fs)
  * packages that are genuinely gone

Only the first set can be repaired, and only as junctions into the asar paths —
a plain symlink into `.asar` is invisible to non-Electron tooling, but Electron
itself resolves it fine, which is what matters at runtime.

    python tools/repair_profile_links.py --dry-run
    python tools/repair_profile_links.py --apply
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

PROFILES_MODULES = os.path.expanduser(r"~\.dsh\profiles\node_modules")
NEW_ROOT = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
            r"\resources\app.asar\dsh\node_modules")
ELECTRON = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
            r"\DeepSeek Harness.exe")


def broken_links() -> list[tuple[str, str]]:
    """(relative package path, current target) for links that cannot be used.

    Enumerated via PowerShell: Windows junctions are reparse points that
    os.walk() does not report as symlinks, so a pure-Python walk sees nothing.

    "Broken" is judged by whether the link's `package.json` is reachable, not by
    Test-Path: PowerShell reports a dangling junction as existing, so Test-Path
    says True for every one of the ~550 dead links on this machine.
    """
    script = (
        f"$root = '{PROFILES_MODULES}';"
        "Get-ChildItem -Path $root -Recurse -Force -Directory -ErrorAction SilentlyContinue | "
        "Where-Object { $_.LinkType -eq 'SymbolicLink' -or $_.LinkType -eq 'Junction' } | "
        "ForEach-Object {"
        "  $pkg = Join-Path $_.FullName 'package.json';"
        "  if (-not (Test-Path -LiteralPath $pkg)) {"
        "    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\\\','/';"
        "    Write-Output ($rel + '|' + [string]$_.Target)"
        "  }"
        "}"
    )
    r = subprocess.run(["pwsh", "-NoProfile", "-Command", script],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise SystemExit(f"link enumeration failed: {(r.stderr or '')[:300]}")
    out = []
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        rel, target = line.split("|", 1)
        out.append((rel.strip(), target.strip()))
    return sorted(set(out))


def probe_asar(rels: list[str]) -> dict[str, bool]:
    """Ask Electron which packages exist inside the new install (asar-aware)."""
    script = (
        "const fs=require('fs');"
        f"const root={json.dumps(NEW_ROOT)};"
        "const rels=JSON.parse(process.argv[1]);"
        "const out={};"
        "for(const r of rels) out[r]=fs.existsSync(root+'\\\\'+r.replace(/\\//g,'\\\\'));"
        "console.log(JSON.stringify(out));"
    )
    env = {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}
    r = subprocess.run([ELECTRON, "-e", script, json.dumps(rels)],
                       capture_output=True, text=True, encoding="utf-8", env=env)
    if r.returncode != 0:
        raise SystemExit(f"asar probe failed: {r.stderr[:300]}")
    return json.loads(r.stdout.strip().split("\n")[-1])


def main() -> int:
    apply = "--apply" in sys.argv
    entries = broken_links()
    rels = [rel for rel, _target in entries]
    print(f"unusable links under profiles/node_modules: {len(rels)}")
    if not rels:
        print("nothing to repair")
        return 0
    old = {rel: target for rel, target in entries}
    old_roots = sorted({os.path.dirname(t) for t in old.values()})
    print(f"  all point into {len(old_roots)} stale root(s), e.g. {old_roots[0] if old_roots else 'n/a'}")

    present = probe_asar(rels)
    repairable = [r for r in rels if present.get(r)]
    missing = [r for r in rels if not present.get(r)]
    print(f"  resolvable in current install : {len(repairable)}")
    print(f"  genuinely absent              : {len(missing)}")
    for m in missing[:8]:
        print(f"    absent: {m}")

    if not apply:
        print("\n(dry run — pass --apply to rewrite the repairable links)")
        return 0

    fixed = 0
    for rel in repairable:
        link = os.path.join(PROFILES_MODULES, rel.replace("/", os.sep))
        target = os.path.join(NEW_ROOT, rel.replace("/", os.sep))
        # Junctions are reparse points: os.remove/os.unlink leave them behind on
        # Windows, so removal and creation both go through PowerShell.
        script = (
            f"$link = '{link}'; $target = '{target}';"
            "if (Test-Path -LiteralPath $link) {"
            "  cmd /c rmdir \"$link\" 2>$null;"
            "  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force -Recurse -ErrorAction SilentlyContinue }"
            "}"
            "if (-not (Test-Path -LiteralPath $link)) {"
            "  New-Item -ItemType Junction -Path $link -Target $target -ErrorAction Stop | Out-Null"
            "  Write-Output 'OK'"
            "} else { Write-Output 'STUCK' }"
        )
        r = subprocess.run(["pwsh", "-NoProfile", "-Command", script],
                           capture_output=True, text=True, encoding="utf-8")
        if "OK" in (r.stdout or ""):
            fixed += 1
        else:
            print(f"  could not relink {rel}: {(r.stderr or r.stdout or '').strip()[:120]}")
    print(f"\nrepaired {fixed}/{len(repairable)} links; {len(missing)} left broken (targets absent)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
