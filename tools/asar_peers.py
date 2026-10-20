"""Extract a package and its transitive @deepseek-ai/* dependencies from app.asar.

Materialising one package is not enough: each has its own peer chain, and the
chain is only discoverable by parsing package.json files inside the archive. This
walks that closure and extracts every reachable package into a single directory
that Node can resolve normally.

    python tools/asar_peers.py <dest-dir> @deepseek-ai/dsh-llm @deepseek-ai/schemastery ...

Writes into <dest-dir>/@deepseek-ai/<name>/ and reports anything it could not
find (third-party peers such as `react` are reported, not fetched).
"""

from __future__ import annotations

import json
import os
import struct
import sys

ASAR = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
        r"\resources\app.asar")
PKG_ROOT = "dsh/node_modules"


def open_archive():
    with open(ASAR, "rb") as f:
        _size, header_size, _, _ = struct.unpack("<4I", f.read(16))
        header = f.read(header_size)
        index, _end = json.JSONDecoder().raw_decode(header.decode("utf-8", "replace"))
    return index, 8 + header_size


def node_at(index: dict, package: str):
    node = index
    for part in f"{PKG_ROOT}/{package}".split("/"):
        node = node.get("files", {}).get(part)
        if node is None:
            return None
    return node


def walk_files(node, prefix=""):
    for name, value in node.get("files", {}).items():
        path = f"{prefix}/{name}"
        if "files" in value:
            yield from walk_files(value, path)
        else:
            yield path, value


def read_entry(archive, data_start: int, entry) -> bytes:
    archive.seek(data_start + int(entry["offset"]))
    return archive.read(entry["size"])


def package_manifest(archive, data_start: int, node) -> dict | None:
    entry = node.get("files", {}).get("package.json")
    if entry is None or "offset" not in entry:
        return None
    try:
        return json.loads(read_entry(archive, data_start, entry))
    except ValueError:
        return None


def extract_one(archive, data_start: int, package: str, node, dest: str) -> int:
    """Write one package's files under `dest`.

    `dest` is the package directory itself (scope included), so paths are
    relative to the package root — `lib/index.js`, not `@scope/name/lib/index.js`.
    """
    written = 0
    for path, entry in walk_files(node, f"/{package}"):
        rel = path[len(package) + 1:].lstrip("/")
        if not rel or entry.get("unpacked"):
            continue
        out = os.path.join(dest, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as fh:
            fh.write(read_entry(archive, data_start, entry))
        written += 1
    return written


# Third-party peers: not in the archive, and not needed to exercise the plugin's
# decision/apply paths. Reported so the gap is visible rather than silent.
EXTERNAL_OK = {"react", "react-dom", "@types/react"}


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    dest = sys.argv[1]
    roots = sys.argv[2:]

    index, data_start = open_archive()
    queue = list(roots)
    seen: set[str] = set()
    extracted: list[str] = []
    external: set[str] = set()
    missing: set[str] = set()

    with open(ASAR, "rb") as archive:
        while queue:
            package = queue.pop(0)
            if package in seen or not package.startswith(("@deepseek-ai/", "cordis", "cosmokit")):
                continue
            seen.add(package)
            node = node_at(index, package)
            if node is None:
                missing.add(package)
                continue
            manifest = package_manifest(archive, data_start, node) or {}
            peers = list(manifest.get("dependencies") or {}) + list(manifest.get("peerDependencies") or {})
            for dep in peers:
                if dep.startswith("@deepseek-ai/") or dep.split("/")[0] in ("cordis", "cosmokit"):
                    queue.append(dep)
                elif dep not in EXTERNAL_OK:
                    external.add(dep)
            short = package if "/" in package else package
            # Preserve the scope: @deepseek-ai/x must land in node_modules/@deepseek-ai/x,
            # or Node's resolver never finds it.
            out_dir = os.path.join(dest, *short.split("/"))
            count = extract_one(archive, data_start, package, node, out_dir)
            extracted.append(f"{package} ({count} files)")

    print(f"extracted {len(extracted)} packages -> {dest}")
    for line in extracted:
        print(f"  {line}")
    if missing:
        print(f"\nnot in archive ({len(missing)}): {', '.join(sorted(missing)[:6])}")
    if external:
        print(f"\nexternal peers not vendored ({len(external)}): {', '.join(sorted(external)[:8])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
