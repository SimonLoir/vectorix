# Document extraction artifacts

`@repo/documents` defines the versioned extraction format, immutable UTF-16 source offsets, safe parser diagnostics and storage reservations shared by API and workers. It contains no native parser or network client. Heavy extraction lives in `apps/workers/src/extraction/` and is injected into `processDocumentIngestions` by the worker entry point.

TXT/Markdown keep the existing `utf8-text-v1` plain-text object. PDF/DOCX use `pdf-structured-v1` and `docx-structured-v1` JSON artifacts. Readers accept both representations. A structured artifact contains text, ordered source ranges and page-specific warnings. PDF sources use physical page numbers; DOCX sources use paragraphs and current sections, never inferred pages. Offsets refer to the extracted text, rather than original file byte positions.

Rich extraction reserves 10 MiB before original upload, independently of the original's compressed size. Text is bounded to 8 MiB of UTF-8; the complete serialized artifact is bounded to 10 MiB. Successful publication replaces the reservation with actual artifact bytes. Failed or interrupted writes retain the reservation until retry or confirmed cleanup. Keep original, artifact and vector accounting independent.

`publicIngestionTask` maps new safe domain diagnostics to the existing closed V1 `errorCode` enum, exposing the more precise optional `diagnostic` field to new clients. Never return native stderr, ZIP/XML errors, paths or document content as an error message.

See [PDF/DOCX behavior and acceptance](../../docs/rag-rich-documents.md) and [document lifecycle](../../docs/rag-document-lifecycle.md).
