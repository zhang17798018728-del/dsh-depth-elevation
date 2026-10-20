"""Extract a package subtree out of an Electron app.asar archive.

`app.asar` is a concatenated blob behind a JSON header, not a directory, so
normal file APIs cannot see inside it. Node's ESM resolver also cannot follow a
junction that points into it. For testing a plugin whose peers only exist inside
the archive, the packages have to be materialised on disk first.

This does exactly that, for one package at a time — no dependency resolution, no
asar tooling, no network.

    python tools/asar_extract.py <package-name> <dest-dir>
    python tools/asar_extract.py @deepseek-ai/dsh-llm /tmp/peers
"""

from __future__ import annotations

import json
import os
import struct
import sys

ASAR = (r"C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness"
        r"\resources\app.asar")
PKG_ROOT = "dsh/node_modules"      # packages live under this prefix in the archive


def load(archive: str):
    with open(archive, "rb") as f:
        _size, header_size, _, _ = struct.unpack("<4I", f.read(16))
        header = f.read(header_size)
        index, end = json.JSONDecoder().raw_decode(header.decode("utf-8", "replace"))
        # Data begins after the 8-byte (size + headerSize) prefix and the header.
        data_start = 8 + header_size
    return index, data_start


def walk(node, prefix=""):
    for name, value in node.get("files", {}).items():
        path = f"{prefix}/{name}"
        if "files" in value:
            yield from walk(value, path)
        else:
            yield path, value


def extract(package: str, dest: str) -> int:
    index, data_start = load(ASAR)
    # Descend to the package folder.
    node = index
    parts = f"{PKG_ROOT}/{package}".split("/")
    for part in parts:
        node = node["files"].get(part)
        if node is None:
            raise SystemExit(f"package not in archive: {package}")
        if "files" not in node and part != parts[-1]:
            raise SystemExit(f"unexpected layout at {part}")

    written = 0
    with open(ASAR, "rb") as archive:
        for path, entry in walk(node, f"/{package}"):
            # path looks like /@scope/name/lib/index.js -> strip the package prefix
            rel = path[len(package) + 1:].lstrip("/")
            if not rel:
                continue
            out = os.path.join(dest, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(out), exist_ok=True)
            archive.seek(data_start + int(entry["offset"]))
            data = archive.read(entry["size"])
            # Only unpack entries Electron stores raw; behind an "unpacked" flag
            # the bytes live in app.asar.unpacked and are copied verbatim there.
            if entry.get("unpacked"):
                continue
            with open(out, "wb") as fh:
                fh.write(data)
            written += 1
    return written


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    package, dest = sys.argv[1], sys.argv[2]
    os.makedirs(dest, exist_ok=True)
    count = extract(package, dest)
    print(f"{package}: {count} files -> {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
