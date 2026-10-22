import { z } from 'zod';
import { Buffer } from 'node:buffer';

export const MAX_RICH_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_RICH_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 500;
export const MAX_DOCUMENT_SOURCES = 5000;
export const parserDiagnostic = z.enum([
    'PDF_OCR_UNAVAILABLE',
    'PDF_ENCRYPTED',
    'FILE_INVALID',
    'PARSER_LIMIT',
    'PARSER_TIMEOUT',
    'PARSER_UNAVAILABLE',
]);
export type ParserDiagnostic = z.infer<typeof parserDiagnostic>;
/** Safe domain codes only: never attach a parser's stderr, file contents or paths. */
export class DocumentParserError extends Error {
    constructor(readonly code: ParserDiagnostic) {
        super(code);
    }
}
export const extractionSource = z.object({
    kind: z.enum(['text', 'pdf-page', 'docx-paragraph']),
    index: z
        .number()
        .int()
        .min(0)
        .max(MAX_DOCUMENT_SOURCES - 1),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    page: z.number().int().min(1).max(MAX_PDF_PAGES).optional(),
    paragraph: z.number().int().min(1).max(MAX_DOCUMENT_SOURCES).optional(),
    section: z.number().int().min(1).max(MAX_DOCUMENT_SOURCES).optional(),
    heading: z.string().max(200).optional(),
    part: z
        .enum(['body', 'header', 'footer', 'footnote', 'endnote'])
        .optional(),
    partIndex: z.number().int().min(1).max(2000).optional(),
});
export const structuredExtraction = z
    .object({
        schemaVersion: z.literal(1),
        format: z.enum(['TEXT', 'MARKDOWN', 'PDF', 'DOCX']),
        text: z.string().max(25 * 1024 * 1024),
        sources: z.array(extractionSource).min(1).max(MAX_DOCUMENT_SOURCES),
        warnings: z
            .array(
                z.object({
                    code: z.literal('NO_TEXT'),
                    sourceIndex: z
                        .number()
                        .int()
                        .min(0)
                        .max(MAX_DOCUMENT_SOURCES - 1),
                })
            )
            .max(MAX_DOCUMENT_SOURCES),
    })
    .superRefine((value, context) => {
        let previous = 0;
        for (let index = 0; index < value.sources.length; index++) {
            const source = value.sources[index]!;
            if (
                source.index !== index ||
                source.start < previous ||
                source.end < source.start ||
                source.end > value.text.length
            )
                context.addIssue({
                    code: 'custom',
                    message: 'Invalid source offsets.',
                });
            previous = source.end;
        }
        if (
            value.warnings.some(
                (warning) => warning.sourceIndex >= value.sources.length
            )
        )
            context.addIssue({
                code: 'custom',
                message: 'Invalid source warning.',
            });
    });
export type StructuredExtraction = z.infer<typeof structuredExtraction>;
export type ExtractionSource = z.infer<typeof extractionSource>;
export type RichDocumentParser = (
    bytes: Uint8Array,
    mediaType: string
) => Promise<StructuredExtraction>;

export const documentMediaTypes = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;
/** Extension-based format selection ignores untrusted client MIME; worker parsers verify the package signature. */
export function mediaTypeForFile(name: string) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return;
    const extension = name.slice(dot + 1).toLowerCase();
    return Object.hasOwn(documentMediaTypes, extension)
        ? documentMediaTypes[extension as keyof typeof documentMediaTypes]
        : undefined;
}
export function isRichDocument(mediaType: string) {
    return (
        mediaType === documentMediaTypes.pdf ||
        mediaType === documentMediaTypes.docx
    );
}
/** Compressed originals can expand: reserve the full bounded artifact budget before accepting PDF/DOCX. */
export function extractionReservation(
    mediaType: string,
    originalBytes: bigint | number
) {
    return isRichDocument(mediaType)
        ? BigInt(MAX_RICH_ARTIFACT_BYTES)
        : BigInt(originalBytes);
}
/** Serialize a validated, bounded artifact with immutable UTF-16 source offsets. */
export function encodeStructuredExtraction(value: StructuredExtraction) {
    const artifact = structuredExtraction.parse(value);
    if (Buffer.byteLength(artifact.text, 'utf8') > MAX_RICH_TEXT_BYTES)
        throw new DocumentParserError('PARSER_LIMIT');
    const bytes = Buffer.from(JSON.stringify(artifact), 'utf8');
    if (bytes.byteLength > MAX_RICH_ARTIFACT_BYTES)
        throw new DocumentParserError('PARSER_LIMIT');
    return bytes;
}
/** Old plain-text objects remain readable; new versioned artifacts carry stable source positions. */
export function decodeStoredExtraction(
    bytes: Uint8Array,
    extractorVersion: string
): StructuredExtraction {
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (
            extractorVersion === 'pdf-structured-v1' ||
            extractorVersion === 'docx-structured-v1'
        ) {
            if (bytes.byteLength > MAX_RICH_ARTIFACT_BYTES)
                throw new Error('limit');
            const artifact = structuredExtraction.parse(JSON.parse(text));
            const expectedFormat =
                extractorVersion === 'pdf-structured-v1' ? 'PDF' : 'DOCX';
            if (
                artifact.format !== expectedFormat ||
                Buffer.byteLength(artifact.text, 'utf8') > MAX_RICH_TEXT_BYTES
            )
                throw new Error('format');
            return artifact;
        }
        if (extractorVersion !== 'utf8-text-v1') throw new Error('version');
        return {
            schemaVersion: 1,
            format: 'TEXT',
            text,
            sources: [{ kind: 'text', index: 0, start: 0, end: text.length }],
            warnings: [],
        };
    } catch {
        throw new DocumentParserError('FILE_INVALID');
    }
}
/** Maintain the original closed V1 error enum while exposing opt-in structured parser diagnostics. */
export function publicIngestionTask<T extends { errorCode: string | null }>(
    task: T | null
) {
    if (!task) return null;
    const diagnostic = parserDiagnostic.safeParse(task.errorCode);
    if (!diagnostic.success) return { ...task, diagnostic: null };
    const errorCode =
        diagnostic.data === 'PDF_OCR_UNAVAILABLE'
            ? 'TEXT_EMPTY'
            : diagnostic.data === 'FILE_INVALID' ||
                diagnostic.data === 'PDF_ENCRYPTED'
              ? 'TEXT_INVALID'
              : 'PROCESSING_FAILED';
    return { ...task, errorCode, diagnostic: diagnostic.data };
}
