#!/usr/bin/env python3
"""Derive xref-only recovery fixtures; preserve every original object/content byte."""

import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


def shift_first_xref_offset(source: bytes) -> bytes:
    """Move only the first in-use xref offset seven bytes beyond its true object."""
    xref = source.index(b"\nxref\n")
    entry = re.search(rb"(?m)^(\d{10}) \d{5} n \r?$", source)
    if entry is None or entry.start() <= xref:
        raise ValueError("Expected a generated classic cross-reference table")
    start, end = entry.span(1)
    offset = int(entry.group(1))
    if not source[offset:].startswith(b"1 0 obj\n"):
        raise ValueError("Expected the first object in the generated source")
    replacement = f"{offset + 7:010d}".encode("ascii")
    if len(replacement) != end - start:
        raise ValueError("The offset change must preserve byte positions")
    result = source[:start] + replacement + source[end:]
    if result[:xref] != source[:xref] or len(result) != len(source):
        raise ValueError("Objects, compressed content and input length must remain unchanged")
    return result


def main() -> None:
    for original, destination in [
        ("text-fr-en.pdf", "xref-reconstructed.pdf"),
        ("partial-corrupt.pdf", "xref-partial-corrupt.pdf"),
    ]:
        source = (ROOT / original).read_bytes()
        (ROOT / destination).write_bytes(shift_first_xref_offset(source))
    expected_path = ROOT / "expected.json"
    expected = json.loads(expected_path.read_text(encoding="utf8"))
    expected["xref-reconstructed.pdf"] = {
        "pages": expected["text-fr-en.pdf"]["pages"],
        "canonicalSha256": "1070ac3250f8b8649f5f2ee82c6a42accad291cc67005ac2c93583789285d0a1",
        "sourceRanges": [
            {"index": 0, "page": 1, "start": 0, "end": 66},
            {"index": 1, "page": 2, "start": 68, "end": 134},
        ],
    }
    artifact = {
        "schemaVersion": 1,
        "format": "PDF",
        "text": "\n\n".join(expected["text-fr-en.pdf"]["pages"]),
        "sources": [
            {"kind": "pdf-page", "index": item["index"], "start": item["start"], "end": item["end"], "page": item["page"]}
            for item in expected["xref-reconstructed.pdf"]["sourceRanges"]
        ],
        "warnings": [],
    }
    artifact_bytes = json.dumps(artifact, ensure_ascii=False, separators=(",", ":")).encode("utf8")
    expected["xref-reconstructed.pdf"]["artifactBytes"] = len(artifact_bytes)
    expected["xref-reconstructed.pdf"]["artifactSha256"] = hashlib.sha256(artifact_bytes).hexdigest()
    expected["xref-partial-corrupt.pdf"] = {"expectedError": "FILE_INVALID"}
    expected_path.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print("Generated two xref-only variants without changing their source fixtures")


if __name__ == "__main__":
    main()
