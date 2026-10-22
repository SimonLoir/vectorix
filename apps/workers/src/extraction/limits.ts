import {
    DocumentParserError,
    MAX_RICH_TEXT_BYTES,
    MAX_RICH_ARTIFACT_BYTES,
    MAX_PDF_PAGES,
    MAX_DOCUMENT_SOURCES,
    documentMediaTypes,
    encodeStructuredExtraction,
    type StructuredExtraction,
} from '@repo/documents';
export { DocumentParserError } from '@repo/documents';
export type {
    StructuredExtraction,
    ExtractionSource,
    ParserDiagnostic as ParserErrorCode,
} from '@repo/documents';

export const LIMITS = Object.freeze({
    inputBytes: 25 * 1024 * 1024,
    textBytes: MAX_RICH_TEXT_BYTES,
    artifactBytes: MAX_RICH_ARTIFACT_BYTES,
    timeoutMs: 30_000,
    stderrBytes: 32 * 1024,
    pdfPages: MAX_PDF_PAGES,
    zipEntries: 2000,
    zipDeclaredBytes: 100 * 1024 * 1024,
    mainXmlBytes: 8 * 1024 * 1024,
    metadataXmlBytes: 256 * 1024,
    totalXmlBytes: 16 * 1024 * 1024,
    paragraphs: MAX_DOCUMENT_SOURCES,
    xmlDepth: 128,
    xmlAttributes: 64,
});

export const PDF_MEDIA_TYPE = documentMediaTypes.pdf;
export const DOCX_MEDIA_TYPE = documentMediaTypes.docx;
/** Validate schema, source offsets and serialized storage limits before IPC or durable writes. */
export function validateExtraction(
    value: StructuredExtraction
): StructuredExtraction {
    try {
        encodeStructuredExtraction(value);
    } catch (error) {
        if (error instanceof DocumentParserError) throw error;
        throw new DocumentParserError('FILE_INVALID');
    }
    return value;
}
/** Empty or punctuation-only output cannot establish a usable text extraction. */
export function hasUsableText(text: string) {
    return /[\p{L}\p{N}]/u.test(text);
}
