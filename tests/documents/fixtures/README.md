# Vectorix M2b real document fixtures

These files are actual compressed PDFs and OOXML ZIP packages, with deliberate malformed variants. They do not substitute parser return values or mock extraction. All content is synthetic and contains no production data.

Regenerate deterministically with Python 3 and its standard library:

```sh
python3 tests/documents/fixtures/generate-fixtures.py
python3 tests/documents/fixtures/verify-fixtures.py
pnpm exec prettier --write tests/documents/fixtures/expected.json
```

`generate-fixtures.py` builds PDF objects, compressed content/image streams and cross-reference tables; its encrypted fixture uses the actual PDF Standard Security Handler revision 2 with deterministic fixture-only passwords. DOCX packages contain real package content types, package relationships, WordprocessingML document XML and styles. ZIP timestamps are fixed. The final command applies repository JSON formatting after generation and independent verification; binary generation itself uses only the Python standard library. Generation does not require LibreOffice, Ghostscript, third-party Python libraries, npm packages or network access.

`expected.json` records expected PDF page text, DOCX paragraph and section positions, and parser failure classifications. PDF expected text excludes harmless trailing page whitespace produced by Poppler. Paragraph text preserves tabs and explicit breaks.

| Fixture                      | Meaning                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text-fr-en.pdf`             | Two pages, English page 1 and French page 2, including accented glyphs with WinAnsi encoding.                                                                                                 |
| `scanned.pdf`                | One image-only page showing raster letters SCAN; no text layer exists. Must fail with `PDF_OCR_UNAVAILABLE`.                                                                                  |
| `mixed.pdf`                  | Text page 1, image-only page 2. Must retain page 2 and report a no-text warning.                                                                                                              |
| `blank-page.pdf`             | Text page 1, genuinely blank page 2. Distinguishes lack of extractable text from proof of scanning.                                                                                           |
| `encrypted.pdf`              | Real encrypted two-page PDF. Fixture-only user password: `vectorix-fixture`; owner password: `vectorix-owner`. Must fail without a password with `PDF_ENCRYPTED`.                             |
| `corrupt.pdf`                | PDF signature without a valid document graph/xref. Must fail with `FILE_INVALID`.                                                                                                             |
| `page-limit.pdf`             | A real 501-page PDF; must hit the 500-page limit.                                                                                                                                             |
| `structure-fr-en.docx`       | Seven paragraphs, two actual Word sections, a style heading, a direct outline heading, multiple runs, tab, explicit line break, two table cells, inserted/deleted content and an instruction. |
| `empty.docx`                 | Valid package with no usable body text; must never report successful extraction.                                                                                                              |
| `malformed.docx`             | Mismatched closing element in main XML.                                                                                                                                                       |
| `doctype.docx`               | Main document has a DTD/entity declaration; must be rejected.                                                                                                                                 |
| `external-relationship.docx` | A document image relationship targets an external URL. It is rejected and nothing fetches that URL.                                                                                           |
| `macro.docx`                 | Macro-enabled main content type and a `vbaProject.bin` entry under a `.docx` filename.                                                                                                        |
| `duplicate-entry.docx`       | Two identical main-document entry names.                                                                                                                                                      |
| `traversal-entry.docx`       | An additional `../escape.xml` entry.                                                                                                                                                          |
| `crc-mismatch.docx`          | ZIP central directory CRC for main document is deliberately wrong. Python ZIP independently rejects it.                                                                                       |
| `encrypted-entry.docx`       | The main document central-directory encryption flag is set. Payload is deliberately not encrypted because rejection must happen at preflight.                                                 |
| `zipbomb.docx`               | Main XML expands beyond 9 MiB although the archive is about 10 KiB. Must hit the 8 MiB main-XML limit.                                                                                        |
| `declared-zipbomb.docx`      | Central directory declares a 101 MiB main XML. Must hit preflight declared-size limit before decompression.                                                                                   |
| `paragraph-limit.docx`       | A real package containing 5,001 paragraphs; must hit the 5,000-paragraph limit.                                                                                                               |
| `entry-limit.docx`           | A real ZIP containing 2,001 entries; must hit the 2,000-entry limit.                                                                                                                          |
| `partial-corrupt.pdf`        | Page 2 has usable prefix text followed by an unterminated PDF string. Poppler exits zero but reports syntax errors; the parser must reject hidden partial extraction.                         |
| `alternate-content.docx`     | Contains mutually exclusive `mc:Choice` and `mc:Fallback` paragraphs. The initial parser rejects unsupported alternate content rather than concatenate both branches.                         |
| `historical-section.docx`    | A former paragraph properties subtree contains `sectPr`; both current paragraphs remain in section 1.                                                                                         |
| `subdocument.docx`           | Main body references an unsupported internal subdocument. Must reject rather than silently omit its content.                                                                                  |
| `wrong-package-root.docx`    | Content-types namespace is correct but root is `WrongRoot`; namespace-only checks must not accept it.                                                                                         |

`generate-adversarial.py` creates the five peer-review cases and is automatically invoked by the main generator when present. It can also run independently after the base generator.

The good DOCX's paragraph positions are:

1. Section 1, heading `Guide français`.
2. Section 1, `Bonjour équipe. English paragraph.`, followed by a tab and `Après tabulation.`, a line break, then `Second line.`
3. Section 1, `End of section one.`; its paragraph properties end section 1.
4. Section 2, heading `English section`.
5. Section 2, `Visible text. Inserted text.`. Exclude `DELETED SECRET` and `INSTRUCTION SECRET`.
6. Section 2, table cell `Cellule française`.
7. Section 2, table cell `English table cell`.

The initial independent check used host Poppler 26.01.0. It found exactly the expected page counts and French/English text. The scan produced only `\f`; the mixed/blank PDFs produced `\f\f` after the first page's text. The encrypted PDF failed with `Command Line Error: Incorrect password`, and successfully produced both pages when the fixture password was supplied. The corruption fixture failed because Poppler could not read an xref table. Python `zipfile` validated the good DOCX and rejected the deliberately incorrect CRC.

The extended fixtures also cover `hyperlinks.docx` (displayed HTTP/HTTPS/mailto link text remains inert; destinations never enter extraction), `stories.docx` (body, header, footer, footnote and endnote paragraphs with a global part index and local paragraph positions), `story-paragraph-limit.docx` (5,001 paragraphs across multiple parts), and `spoofed-encrypted-title.pdf` (untrusted Info metadata cannot override the trusted encryption flag). Note separator records and comment annotations are excluded explicitly; their ZIP CRCs are still validated. Body references with no text retain a source and a `NO_TEXT` warning.

The parser rejects macros, ActiveX/OLE packages, external non-hyperlink resources, AlternateContent branches, altChunk and subdocuments. These unsupported structures must fail explicitly rather than silently omit source text. Historical property changes do not change current section positions.

Current-reference regression fixtures verify that relationship declarations alone never activate a header or footer. `stories.docx` contains actual current section references. `live-references.docx` retains orphaned header/footer parts, historical/deleted header references, unreferenced normal notes and deleted note references while its expected extraction contains only current body content, the referenced header/footer and referenced note IDs. A live reference from the header activates a second footnote. Missing, wrong-role, duplicate section references and cross-note references fail explicitly; `orphan-crc-mismatch.docx` proves unused content is still checksum-validated.
