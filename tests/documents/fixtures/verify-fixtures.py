#!/usr/bin/env python3
"""Independently verify generated fixture validity with Poppler and Python ZIP/XML."""

import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
EXPECTED = json.loads((ROOT / "expected.json").read_text(encoding="utf8"))


def command(*args):
    return subprocess.run(args, capture_output=True, check=False)


def main():
    version = command("/usr/bin/pdftotext", "-v")
    print(version.stderr.decode().splitlines()[0])
    for name in ["text-fr-en.pdf", "scanned.pdf", "mixed.pdf", "blank-page.pdf"]:
        info = command("/usr/bin/pdfinfo", str(ROOT / name))
        assert info.returncode == 0, (name, info.stderr)
        result = command("/usr/bin/pdftotext", "-enc", "UTF-8", "-eol", "unix", str(ROOT / name), "-")
        assert result.returncode == 0, (name, result.stderr)
        pages = result.stdout.decode("utf8").split("\f")
        assert pages[-1] == "", (name, pages)
        pages = [page.strip() for page in pages[:-1]]
        assert pages == EXPECTED[name]["pages"], (name, pages)
        print(f"PASS {name}: {len(pages)} actual PDF pages and expected text")
    encrypted = command("/usr/bin/pdfinfo", str(ROOT / "encrypted.pdf"))
    assert encrypted.returncode != 0
    assert b"Incorrect password" in encrypted.stderr
    decrypted = command("/usr/bin/pdftotext", "-upw", "vectorix-fixture", str(ROOT / "encrypted.pdf"), "-")
    assert decrypted.returncode == 0
    assert "Bonjour équipe" in decrypted.stdout.decode("utf8")
    print("PASS encrypted.pdf: fails without a password and really decrypts with fixture password")
    corrupt = command("/usr/bin/pdfinfo", str(ROOT / "corrupt.pdf"))
    assert corrupt.returncode != 0
    print("PASS corrupt.pdf: independently rejected by Poppler")
    with zipfile.ZipFile(ROOT / "structure-fr-en.docx") as archive:
        assert archive.testzip() is None
        root = ET.fromstring(archive.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        assert len(root.findall(".//w:body//w:p", ns)) == 7
        assert len(root.findall(".//w:body//w:sectPr", ns)) == 2
    print("PASS structure-fr-en.docx: good CRCs, real OOXML, seven paragraphs, two sections")
    with zipfile.ZipFile(ROOT / "live-references.docx") as archive:
        assert archive.testzip() is None
        current = ET.fromstring(archive.read("word/document.xml"))
        relationship_id = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        section = current.find("./w:body/w:sectPr", ns)
        assert section.find("w:headerReference", ns).attrib[relationship_id] == "currentHeader"
        assert section.find("w:footerReference", ns).attrib[relationship_id] == "currentFooter"
        assert current.find(".//w:pPrChange//w:headerReference", ns).attrib[relationship_id] == "historicalHeader"
        assert current.find(".//w:del//w:headerReference", ns).attrib[relationship_id] == "deletedHeader"
        assert any(node.attrib[f"{{{ns['w']}}}id"] == "3" for node in current.findall(".//w:del//w:footnoteReference", ns))
        header = ET.fromstring(archive.read("word/header1.xml"))
        assert header.find(".//w:footnoteReference", ns).attrib[f"{{{ns['w']}}}id"] == "4"
        assert b"ORPHAN HEADER SECRET" in archive.read("word/header2.xml")
        notes = ET.fromstring(archive.read("word/footnotes.xml"))
        assert {node.attrib[f"{{{ns['w']}}}id"] for node in notes.findall("w:footnote", ns)} == {"2", "3", "4", "5"}
    print("PASS live-references.docx: real current/deleted/historical references, header note reference and retained orphan content")
    with zipfile.ZipFile(ROOT / "orphan-crc-mismatch.docx") as archive:
        try:
            archive.read("word/header2.xml")
        except zipfile.BadZipFile:
            pass
        else:
            raise AssertionError("Deliberately wrong orphan-part CRC unexpectedly passed")
    print("PASS orphan-crc-mismatch.docx: Python independently rejects corrupted unreferenced content")
    with zipfile.ZipFile(ROOT / "crc-mismatch.docx") as archive:
        try:
            archive.read("word/document.xml")
        except zipfile.BadZipFile:
            pass
        else:
            raise AssertionError("Deliberately wrong CRC unexpectedly passed")
    print("PASS crc-mismatch.docx: independently rejected by Python ZIP")
    with zipfile.ZipFile(ROOT / "zipbomb.docx") as archive:
        assert archive.getinfo("word/document.xml").file_size > 8 * 1024 * 1024
    with zipfile.ZipFile(ROOT / "entry-limit.docx") as archive:
        assert len(archive.infolist()) == 2001
    with zipfile.ZipFile(ROOT / "paragraph-limit.docx") as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
        assert len(root.findall(".//w:p", ns)) == 5001
    print("PASS resource fixtures: real expanded main XML, 2,001 entries and 5,001 paragraphs")
    binaries = sorted([*ROOT.glob("*.pdf"), *ROOT.glob("*.docx")])
    before = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in binaries}
    regenerated = command("python3", str(ROOT / "generate-fixtures.py"))
    assert regenerated.returncode == 0, regenerated.stderr
    after = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in binaries}
    assert before == after
    print(f"PASS deterministic regeneration: all {len(binaries)} binary SHA-256 hashes unchanged")


if __name__ == "__main__":
    main()
