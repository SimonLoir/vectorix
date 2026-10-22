#!/usr/bin/env python3
"""Generate deterministic, real PDF and OPC/DOCX parser fixtures using Python's stdlib."""

from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import struct
import warnings
import zipfile
import zlib

ROOT = Path(__file__).resolve().parent
PDF_PASSWORD = "vectorix-fixture"
PADDING = bytes.fromhex("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a")


def rc4(key: bytes, data: bytes) -> bytes:
    state = list(range(256))
    index = 0
    for pos in range(256):
        index = (index + state[pos] + key[pos % len(key)]) % 256
        state[pos], state[index] = state[index], state[pos]
    first = second = 0
    result = bytearray()
    for value in data:
        first = (first + 1) % 256
        second = (second + state[first]) % 256
        state[first], state[second] = state[second], state[first]
        result.append(value ^ state[(state[first] + state[second]) % 256])
    return bytes(result)


def padded_password(password: str) -> bytes:
    return (password.encode("latin1") + PADDING)[:32]


def pdf_literal(text: str) -> bytes:
    data = text.encode("cp1252")
    return b"(" + b"".join(
        bytes([value]) if 32 <= value < 127 and value not in (40, 41, 92)
        else ("\\%03o" % value).encode("ascii")
        for value in data
    ) + b")"


def text_stream(lines: list[str]) -> bytes:
    return b"BT /F1 18 Tf 54 782 Td 28 TL\n" + b"\n".join(
        (b"T* " if index else b"") + pdf_literal(line) + b" Tj"
        for index, line in enumerate(lines)
    ) + b"\nET\n"


def raster_fixture() -> tuple[int, int, bytes]:
    """Produce a small monochrome raster containing a readable, deterministic SCAN glyph."""
    glyphs = {
        "S": ["11111", "10000", "10000", "11111", "00001", "00001", "11111"],
        "C": ["11111", "10000", "10000", "10000", "10000", "10000", "11111"],
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    }
    width, height, scale = 300, 120, 8
    image = bytearray([255]) * (width * height)
    for letter_index, letter in enumerate("SCAN"):
        for row, line in enumerate(glyphs[letter]):
            for column, pixel in enumerate(line):
                if pixel == "1":
                    for yy in range(scale):
                        for xx in range(scale):
                            x = 20 + letter_index * 60 + column * scale + xx
                            y = 25 + row * scale + yy
                            image[y * width + x] = 0
    return width, height, bytes(image)


def build_pdf(pages: list[list[str] | None], *, encrypted: bool = False, title: str | None = None) -> bytes:
    """Emit actual compressed PDF content/image streams and a complete cross-reference table."""
    objects: list[bytes] = [b"", b""]
    font_id = len(objects) + 1
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    file_id = hashlib.md5(b"vectorix-m2b-parser-fixtures-v1").digest()
    file_key = b""
    owner_key = user_key = b""
    if encrypted:
        owner_key = rc4(hashlib.md5(padded_password("vectorix-owner")).digest()[:5], padded_password(PDF_PASSWORD))
        file_key = hashlib.md5(padded_password(PDF_PASSWORD) + owner_key + struct.pack("<i", -4) + file_id).digest()[:5]
        user_key = rc4(file_key, PADDING)

    def stream(data: bytes, extra: bytes = b"") -> int:
        number = len(objects) + 1
        payload = zlib.compress(data, 9)
        if encrypted:
            key = hashlib.md5(file_key + number.to_bytes(3, "little") + b"\0\0").digest()[:10]
            payload = rc4(key, payload)
        objects.append(b"<< /Filter /FlateDecode /Length " + str(len(payload)).encode() + b" " + extra + b">>\nstream\n" + payload + b"\nendstream")
        return number

    page_numbers = []
    for lines in pages:
        if lines is None:
            width, height, image = raster_fixture()
            image_number = stream(image, f"/Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceGray /BitsPerComponent 8 ".encode())
            content_number = stream(b"q 510 0 0 204 42 550 cm /Scan Do Q\n")
            resources = f"<< /XObject << /Scan {image_number} 0 R >> >>".encode()
        else:
            content_number = stream(text_stream(lines))
            resources = f"<< /Font << /F1 {font_id} 0 R >> >>".encode()
        page_number = len(objects) + 1
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources " + resources + f" /Contents {content_number} 0 R >>".encode())
        page_numbers.append(page_number)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Kids [" + b" ".join(f"{number} 0 R".encode() for number in page_numbers) + f"] /Count {len(pages)} >>".encode()
    info_id = None
    if title is not None:
        info_id = len(objects) + 1
        objects.append(b"<< /Title " + pdf_literal(title) + b" >>")
    encryption_id = None
    if encrypted:
        encryption_id = len(objects) + 1
        objects.append(b"<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <" + owner_key.hex().encode() + b"> /U <" + user_key.hex().encode() + b"> >>")
    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    trailer = f"trailer\n<< /Size {len(offsets)} /Root 1 0 R".encode()
    if info_id is not None:
        trailer += f" /Info {info_id} 0 R".encode()
    if encryption_id is not None:
        trailer += f" /Encrypt {encryption_id} 0 R /ID [<{file_id.hex()}><{file_id.hex()}>]".encode()
    output.extend(trailer + f" >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""
RELS = f"""<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"""
STYLES = f"""<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="{W_NS}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>"""
DOCUMENT = f"""<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="{W_NS}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Guide français</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Bonjour équipe. </w:t></w:r><w:r><w:t>English paragraph.</w:t><w:tab/><w:t>Après tabulation.</w:t><w:br/><w:t>Second line.</w:t></w:r></w:p>
<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>End of section one.</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>English section</w:t></w:r></w:p>
<w:p><w:r><w:t>Visible text.</w:t></w:r><w:del w:id="1"><w:r><w:delText>DELETED SECRET</w:delText></w:r></w:del><w:r><w:instrText>INSTRUCTION SECRET</w:instrText></w:r><w:ins w:id="2"><w:r><w:t xml:space="preserve"> Inserted text.</w:t></w:r></w:ins></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cellule française</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>English table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>"""


def make_docx(document: str | bytes = DOCUMENT, *, extra: list[tuple[str, str | bytes]] | None = None, types: str = CONTENT_TYPES, relationships: str = RELS, compression: int = zipfile.ZIP_DEFLATED) -> bytes:
    output = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", compression=compression, compresslevel=9 if compression == zipfile.ZIP_DEFLATED else None) as archive:
            for name, payload in [("[Content_Types].xml", types), ("_rels/.rels", relationships), ("word/document.xml", document), ("word/styles.xml", STYLES)] + (extra or []):
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = compression
                info.external_attr = 0o600 << 16
                archive.writestr(info, payload)
    return output.getvalue()


def central_header(data: bytes, entry_name: str) -> int:
    start = 0
    expected = entry_name.encode()
    while True:
        start = data.find(b"PK\x01\x02", start)
        if start < 0:
            raise ValueError(f"Missing ZIP entry {entry_name}")
        size = struct.unpack_from("<H", data, start + 28)[0]
        if data[start + 46:start + 46 + size] == expected:
            return start
        start += 4


def main() -> None:
    english = ["English source - page one.", "Vectorix preserves PDF page references."]
    french = ["Bonjour équipe - page deux.", "Texte français : été, élève et façade."]
    files = {
        "text-fr-en.pdf": build_pdf([english, french]),
        "scanned.pdf": build_pdf([None]),
        "mixed.pdf": build_pdf([english, None]),
        "blank-page.pdf": build_pdf([english, []]),
        "encrypted.pdf": build_pdf([english, french], encrypted=True),
        "corrupt.pdf": b"%PDF-1.7\nThis is intentionally not a valid PDF.\n%%EOF\n",
        "page-limit.pdf": build_pdf([[f"Page {index + 1}."] for index in range(501)]),
        "structure-fr-en.docx": make_docx(),
        "malformed.docx": make_docx(DOCUMENT.replace("</w:body>", "</w:wrong>")),
        "doctype.docx": make_docx(DOCUMENT.replace("<w:document", '<!DOCTYPE root [<!ENTITY boom "not allowed">]><w:document', 1)),
        "external-relationship.docx": make_docx(extra=[("word/_rels/document.xml.rels", f'<Relationships xmlns="{REL_NS}"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/private" TargetMode="External"/></Relationships>')]),
        "macro.docx": make_docx(types=CONTENT_TYPES.replace("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml", "application/vnd.ms-word.document.macroEnabled.main+xml"), extra=[("word/vbaProject.bin", b"fake macro bytes")]),
        "duplicate-entry.docx": make_docx(extra=[("word/document.xml", DOCUMENT)]),
        "traversal-entry.docx": make_docx(extra=[("../escape.xml", "<escape/>")]),
        "empty.docx": make_docx(f'<w:document xmlns:w="{W_NS}"><w:body><w:p/><w:sectPr/></w:body></w:document>'),
        "zipbomb.docx": make_docx(f'<w:document xmlns:w="{W_NS}"><w:body><w:p><w:r><w:t>' + "A" * (9 * 1024 * 1024) + '</w:t></w:r></w:p></w:body></w:document>'),
        "paragraph-limit.docx": make_docx(f'<w:document xmlns:w="{W_NS}"><w:body>' + '<w:p><w:r><w:t>Paragraph.</w:t></w:r></w:p>' * 5001 + '</w:body></w:document>'),
        "entry-limit.docx": make_docx(extra=[(f"extra/part-{index:04d}.xml", "<extra/>") for index in range(1997)]),
    }
    crc = bytearray(make_docx())
    crc_header = central_header(crc, "word/document.xml")
    struct.pack_into("<I", crc, crc_header + 16, 0xDEADBEEF)
    files["crc-mismatch.docx"] = bytes(crc)
    encrypted_zip = bytearray(make_docx())
    enc_header = central_header(encrypted_zip, "word/document.xml")
    flags = struct.unpack_from("<H", encrypted_zip, enc_header + 8)[0]
    struct.pack_into("<H", encrypted_zip, enc_header + 8, flags | 1)
    files["encrypted-entry.docx"] = bytes(encrypted_zip)
    fake_size = bytearray(make_docx())
    fake_header = central_header(fake_size, "word/document.xml")
    struct.pack_into("<I", fake_size, fake_header + 24, 101 * 1024 * 1024)
    files["declared-zipbomb.docx"] = bytes(fake_size)
    for name, content in files.items():
        (ROOT / name).write_bytes(content)
    expected = {
        "text-fr-en.pdf": {"pages": ["\n".join(english), "\n".join(french)]},
        "scanned.pdf": {"pages": [""], "expectedError": "PDF_OCR_UNAVAILABLE"},
        "mixed.pdf": {"pages": ["\n".join(english), ""], "noTextPages": [2]},
        "blank-page.pdf": {"pages": ["\n".join(english), ""], "noTextPages": [2]},
        "encrypted.pdf": {"expectedError": "PDF_ENCRYPTED", "fixturePassword": PDF_PASSWORD},
        "corrupt.pdf": {"expectedError": "FILE_INVALID"},
        "page-limit.pdf": {"expectedError": "PARSER_LIMIT", "pageCount": 501},
        "structure-fr-en.docx": {
            "paragraphs": [
                {"paragraph": 1, "section": 1, "heading": "Guide français", "text": "Guide français"},
                {"paragraph": 2, "section": 1, "text": "Bonjour équipe. English paragraph.\tAprès tabulation.\nSecond line."},
                {"paragraph": 3, "section": 1, "text": "End of section one."},
                {"paragraph": 4, "section": 2, "heading": "English section", "text": "English section"},
                {"paragraph": 5, "section": 2, "text": "Visible text. Inserted text."},
                {"paragraph": 6, "section": 2, "text": "Cellule française"},
                {"paragraph": 7, "section": 2, "text": "English table cell"},
            ],
            "excludedText": ["DELETED SECRET", "INSTRUCTION SECRET"],
        },
        "zipbomb.docx": {"expectedError": "PARSER_LIMIT", "mainXmlBytesOver": 8 * 1024 * 1024},
        "declared-zipbomb.docx": {"expectedError": "PARSER_LIMIT", "declaredBytes": 101 * 1024 * 1024},
        "paragraph-limit.docx": {"expectedError": "PARSER_LIMIT", "paragraphs": 5001},
        "entry-limit.docx": {"expectedError": "PARSER_LIMIT", "entries": 2001},
    }
    for name in files:
        if name not in expected:
            expected[name] = {"expectedError": "FILE_INVALID"}
    (ROOT / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({name: len(content) for name, content in files.items()}, indent=2))
    adversarial = ROOT / "generate-adversarial.py"
    if adversarial.exists():
        import runpy
        runpy.run_path(str(adversarial), run_name="__main__")
    stories = ROOT / "generate-stories.py"
    if stories.exists():
        import runpy
        runpy.run_path(str(stories), run_name="__main__")
    live_references = ROOT / "generate-live-references.py"
    if live_references.exists():
        import runpy
        runpy.run_path(str(live_references), run_name="__main__")


if __name__ == "__main__":
    main()
