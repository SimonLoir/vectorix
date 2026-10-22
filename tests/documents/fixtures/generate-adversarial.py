#!/usr/bin/env python3
"""Reproduce peer-review findings without modifying production parser sources."""

import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fixtures", ROOT / "generate-fixtures.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

original_text_stream = fixtures.text_stream
calls = 0


def corrupt_text_stream(lines):
    global calls
    calls += 1
    suffix = b"BT /F1 18 Tf 54 400 Td (BROKEN UNFINISHED STRING" if calls == 2 else b""
    return original_text_stream(lines) + suffix


fixtures.text_stream = corrupt_text_stream
(ROOT / "partial-corrupt.pdf").write_bytes(fixtures.build_pdf([["English text page one."], ["Visible prefix page two."]]))

body = f'''<w:document xmlns:w="{fixtures.W_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"><w:body><mc:AlternateContent><mc:Choice Requires="w14"><w:p><w:r><w:t>CHOSEN CONTENT</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>FALLBACK CONTENT</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent><w:sectPr/></w:body></w:document>'''
(ROOT / "alternate-content.docx").write_bytes(fixtures.make_docx(body))

body = f'''<w:document xmlns:w="{fixtures.W_NS}"><w:body><w:p><w:pPr><w:pPrChange w:id="1"><w:pPr><w:sectPr/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Paragraph one.</w:t></w:r></w:p><w:p><w:r><w:t>Paragraph two same current section.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'''
(ROOT / "historical-section.docx").write_bytes(fixtures.make_docx(body))

relationships = f'''<Relationships xmlns="{fixtures.REL_NS}"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/subDocument" Target="subdocument.xml"/></Relationships>'''
body = f'''<w:document xmlns:w="{fixtures.W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Visible main paragraph.</w:t></w:r></w:p><w:subDoc r:id="rId2"/><w:sectPr/></w:body></w:document>'''
subdocument = f'''<w:document xmlns:w="{fixtures.W_NS}"><w:body><w:p><w:r><w:t>SUBDOCUMENT TEXT OMITTED</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'''
(ROOT / "subdocument.docx").write_bytes(fixtures.make_docx(body, extra=[("word/_rels/document.xml.rels", relationships), ("word/subdocument.xml", subdocument)]))

root_types = fixtures.CONTENT_TYPES.replace("<Types ", "<WrongRoot ").replace("</Types>", "</WrongRoot>")
(ROOT / "wrong-package-root.docx").write_bytes(fixtures.make_docx(types=root_types))

expected = json.loads((ROOT / "expected.json").read_text(encoding="utf8"))
expected.update({
    "partial-corrupt.pdf": {"expectedError": "FILE_INVALID"},
    "alternate-content.docx": {"expectedError": "FILE_INVALID"},
    "historical-section.docx": {"paragraphs": [
        {"paragraph": 1, "section": 1, "text": "Paragraph one."},
        {"paragraph": 2, "section": 1, "text": "Paragraph two same current section."},
    ]},
    "subdocument.docx": {"expectedError": "FILE_INVALID"},
    "wrong-package-root.docx": {"expectedError": "FILE_INVALID"},
})
(ROOT / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print("Generated five adversarial peer-review fixtures and updated expected.json")
