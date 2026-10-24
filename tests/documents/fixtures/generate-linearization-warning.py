#!/usr/bin/env python3
"""Derive four bounded linearization-warning fixtures, never repair general PDFs."""

from __future__ import annotations

import json
from pathlib import Path
import re
import runpy

ROOT = Path(__file__).resolve().parent


def add_invalid_linearization_length(source: bytes) -> bytes:
    """Add optional invalid fast-web-view length metadata to the first Catalog."""
    marker = re.search(rb"startxref\n(\d+)\n%%EOF\n$", source)
    if marker is None:
        raise ValueError("Expected generated classic xref")
    xref = int(marker.group(1))
    if source[xref:xref + 5] != b"xref\n":
        raise ValueError("Expected exact classic xref offset")
    starts = list(re.finditer(rb"(?m)^(\d+) 0 obj\n", source[:xref]))
    if not starts or source[:starts[0].start()] != b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n":
        raise ValueError("Expected generated fixture header")
    objects = []
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else xref
        chunk = source[match.end():end]
        if int(match.group(1)) != index + 1 or not chunk.endswith(b"\nendobj\n"):
            raise ValueError("Expected contiguous fixture object sequence")
        objects.append(chunk[:-len(b"\nendobj\n")])
    if objects[0] != b"<< /Type /Catalog /Pages 2 0 R >>":
        raise ValueError("Expected exact baseline first object")
    old_tail = b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    if not source.endswith(old_tail):
        raise ValueError("Expected unencrypted fixture trailer without Info")
    objects[0] = objects[0][:-2] + b" /Linearized 1 /L 0 >>"
    result = bytearray(source[:starts[0].start()])
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    new_xref = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        result.extend(f"{offset:010d} 00000 n \n".encode())
    result.extend(b"trailer\n<< /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\nstartxref\n" + str(new_xref).encode() + b"\n%%EOF\n")
    return bytes(result)



def main() -> None:
    """Change optional Catalog metadata only; retain all historical fixture inputs."""
    shift_first_xref_offset = runpy.run_path(
        str(ROOT / "generate-xref-recovery.py")
    )["shift_first_xref_offset"]
    generated = {}
    for source_name, warning_name, xref_name in [
        (
            "text-fr-en.pdf",
            "linearization-warning.pdf",
            "linearization-xref-reconstructed.pdf",
        ),
        (
            "partial-corrupt.pdf",
            "linearization-partial-corrupt.pdf",
            "linearization-xref-partial-corrupt.pdf",
        ),
    ]:
        warned = add_invalid_linearization_length((ROOT / source_name).read_bytes())
        generated[warning_name] = warned
        generated[xref_name] = shift_first_xref_offset(warned)
    for name, content in generated.items():
        (ROOT / name).write_bytes(content)
    expected_path = ROOT / "expected.json"
    expected = json.loads(expected_path.read_text(encoding="utf8"))
    for name in ["linearization-warning.pdf", "linearization-xref-reconstructed.pdf"]:
        expected[name] = dict(expected["xref-reconstructed.pdf"])
    for name in ["linearization-partial-corrupt.pdf", "linearization-xref-partial-corrupt.pdf"]:
        expected[name] = {"expectedError": "FILE_INVALID"}
    expected_path.write_text(
        json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({name: len(content) for name, content in generated.items()}, indent=2))


if __name__ == "__main__":
    main()
