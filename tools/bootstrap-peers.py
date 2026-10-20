"""Bootstrap the @deepseek-ai peers this plugin needs to run its tests.

The plugin has no dependencies of its own: at runtime the harness supplies every
`@deepseek-ai/*` peer from its installation scope. Outside the harness (plain
`node test/...`), nothing supplies them, so the suites cannot import `lib/index.js`.

This extracts exactly those peers out of the installed Electron archive into
`packages/dsh-depth-elevation/node_modules`, which is what Node's resolver walks.
It is a *test* bootstrap, not a packaging step — the published plugin still
declares peers and ships no node_modules.

Run once after checkout (or after a DSH upgrade moves the archive):

    python tools/bootstrap-peers.py
"""

from __future__ import annotations

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(HERE)      # the plugin package is the repo root

# Candidate installs, newest convention first. The archive path changed once
# already (resources/app -> resources/app.asar/dsh), so probe rather than assume.
# Override with DSH_ASAR=/path/to/app.asar on other machines or CI.
ASAR_CANDIDATES = [
    os.environ.get("DSH_ASAR", ""),
    r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness\resources\app.asar",
    r"C:\Program Files\DeepSeek Harness\resources\app.asar",
    "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar",
    os.path.expanduser("~/.local/share/deepseek-harness/resources/app.asar"),
]
PKG_ROOT_CANDIDATES = ["dsh/node_modules", "node_modules"]

# The plugin imports these two directly; the rest are their transitive peers.
ROOTS = ["@deepseek-ai/dsh-llm", "@deepseek-ai/schemastery", "@deepseek-ai/cordis"]


def find_archive() -> str:
    for path in ASAR_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit("no DeepSeek Harness app.asar found; edit ASAR_CANDIDATES")


def open_archive(archive: str):
    with open(archive, "rb") as f:
        _size, header_size, _, _ = struct.unpack("<4I", f.read(16))
        header = f.read(header_size)
        index, _end = json.JSONDecoder().raw_decode(header.decode("utf-8", "replace"))
    return index, 8 + header_size


def find_node(index: dict, package: str):
    """Locate a package inside the archive under whichever root layout it uses."""
    for root in PKG_ROOT_CANDIDATES:
        node = index
        ok = True
        for part in f"{root}/{package}".split("/"):
            node = node.get("files", {}).get(part)
            if node is None:
                ok = False
                break
        if ok:
            return node
    return None


def walk_files(node, prefix=""):
    for name, value in node.get("files", {}).items():
        path = f"{prefix}/{name}"
        if "files" in value:
            yield from walk_files(value, path)
        else:
            yield path, value


def main() -> int:
    archive = find_archive()
    index, data_start = open_archive(archive)
    dest_root = os.path.join(WORKSPACE, "node_modules")

    queue = list(ROOTS)
    seen: set[str] = set()
    extracted: list[str] = []
    external: set[str] = set()
    missing: set[str] = set()

    with open(archive, "rb") as archive_file:
        while queue:
            package = queue.pop(0)
            if package in seen:
                continue
            seen.add(package)

            node = find_node(index, package)
            if node is None:
                missing.add(package)
                continue

            entry = node.get("files", {}).get("package.json")
            manifest = {}
            if entry and "offset" in entry:
                archive_file.seek(data_start + int(entry["offset"]))
                try:
                    manifest = json.loads(archive_file.read(entry["size"]))
                except ValueError:
                    manifest = {}

            for dep in list(manifest.get("dependencies") or {}) + list(manifest.get("peerDependencies") or {}):
                if dep.startswith("@deepseek-ai/") or dep.split("/")[0] in ("cordis", "cosmokit"):
                    queue.append(dep)
                else:
                    external.add(dep)

            out_dir = os.path.join(dest_root, *package.split("/"))
            count = 0
            for path, file_entry in walk_files(node, f"/{package}"):
                rel = path[len(package) + 1:].lstrip("/")
                if not rel or file_entry.get("unpacked"):
                    continue
                out = os.path.join(out_dir, rel.replace("/", os.sep))
                os.makedirs(os.path.dirname(out), exist_ok=True)
                archive_file.seek(data_start + int(file_entry["offset"]))
                with open(out, "wb") as fh:
                    fh.write(archive_file.read(file_entry["size"]))
                count += 1
            extracted.append(f"{package} ({count} files)")

    print(f"archive : {archive}")
    print(f"dest    : {dest_root}")
    print(f"extracted {len(extracted)} packages")
    for line in extracted:
        print(f"  {line}")
    if missing:
        print(f"\nnot in archive: {', '.join(sorted(missing))}")
    if external:
        # Not needed for the decision/apply paths; reported so the gap is visible.
        print(f"\nthird-party peers not vendored ({len(external)}): {', '.join(sorted(external)[:8])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
