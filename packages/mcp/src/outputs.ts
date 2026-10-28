import { z } from 'zod';
import { collectionId } from './config';
import { ToolRefusal } from './execution';

const position = z
    .number()
    .int()
    .min(0)
    .max(25 * 1024 * 1024);
const source = z.object({
    receipt: z.string().min(1).max(4096),
    expiresAt: z.date(),
});
const sourceSpan = z.object({
    source: z.object({
        kind: z.enum(['text', 'pdf-page', 'docx-paragraph']),
        index: z.number().int().min(0).max(4999),
        start: position,
        end: position,
        page: z.number().int().min(1).max(500).optional(),
        paragraph: z.number().int().min(1).max(5000).optional(),
        section: z.number().int().min(1).max(5000).optional(),
        heading: z.string().max(200).optional(),
        part: z
            .enum(['body', 'header', 'footer', 'footnote', 'endnote'])
            .optional(),
        partIndex: z.number().int().min(1).max(2000).optional(),
    }),
    start: position,
    end: position,
});
const spans = {
    sourceSpans: z.array(sourceSpan).max(64),
    sourceSpansTruncated: z.boolean(),
};
const citationMetadata = z.object({
    chunkId: collectionId,
    generationId: collectionId,
    publicationId: collectionId,
    documentId: collectionId,
    documentName: z.string().max(4096),
    version: z.number().int().positive(),
    ordinal: z.number().int().nonnegative(),
    startOffset: position.nullable(),
    endOffset: position.nullable(),
    ...spans,
});
const citationOutput = citationMetadata.extend({ source });
const contextOutput = z.object({
    anchorChunkId: collectionId,
    generationId: collectionId,
    documentId: collectionId,
    documentName: z.string().max(4096),
    version: z.number().int().positive(),
    source,
    passages: z
        .array(
            citationOutput.extend({
                text: z.string().max(49_152),
                relation: z.enum(['BEFORE', 'MATCH', 'AFTER']),
            })
        )
        .min(1)
        .max(5),
});
const parent = z.object({
    id: collectionId,
    ordinal: z.number().int().nonnegative(),
    text: z.string().max(49_152),
    startOffset: position,
    endOffset: position,
    tokenCount: z.number().int().nonnegative(),
    tokenCountIsEstimate: z.boolean(),
    ...spans,
});
const tags = z.array(z.string().min(1).max(64)).max(20);
const metadata = z
    .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
        z.union([z.string().max(2000), z.number().finite(), z.boolean()])
    )
    .refine((value) => Object.keys(value).length <= 20);
const searchOutput = z.object({
    generationId: collectionId,
    model: z.string().min(1).max(200),
    strategy: z.enum(['HYBRID', 'LEXICAL', 'VECTOR']),
    vectorUnderfilled: z.boolean(),
    parentUnderfilled: z.boolean().optional(),
    durationMs: z.number().finite().nonnegative(),
    results: z
        .array(
            z.object({
                id: collectionId,
                generationId: collectionId,
                publicationId: collectionId,
                documentId: collectionId,
                documentName: z.string().max(4096),
                version: z.number().int().positive(),
                ordinal: z.number().int().nonnegative(),
                text: z.string().max(49_152),
                tokenCount: z.number().int().nonnegative(),
                tokenCountIsEstimate: z.boolean(),
                language: z.enum(['FR', 'EN', 'MIXED', 'UNDETERMINED']),
                ...spans,
                startOffset: position.nullable().optional(),
                endOffset: position.nullable().optional(),
                parentContext: parent.optional(),
                published: z.boolean(),
                mediaType: z.string().max(128),
                tags,
                metadata,
                source,
                scores: z.object({
                    rrf: z.number().finite(),
                    lexicalRank: z.number().int().nullable(),
                    vectorRank: z.number().int().nullable(),
                    vectorDistance: z.number().finite().nullable(),
                }),
            })
        )
        .max(10),
});
const collectionsOutput = z.object({
    items: z
        .array(
            z.object({
                id: collectionId,
                name: z.string().max(200),
                description: z.string().max(2000),
                permissions: z.object({ read: z.boolean() }),
            })
        )
        .max(20),
});

/** Explicit MCP projections validate runtime data and discard fields outside this read-only tool surface. */
function boundedOutput<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ToolRefusal('INVALID_API_RESPONSE');
    return result.data;
}

/** Validate one scanned API page before projecting only readable collection labels. */
export function readableCollections(value: unknown, limit: number) {
    const result = boundedOutput(collectionsOutput, value);
    if (result.items.length > limit)
        throw new ToolRefusal('INVALID_API_RESPONSE');
    return result;
}

/** Preserve the captured generation and refuse any unrequested result expansion. */
export function retrievedSearch(value: unknown, topK: number) {
    const result = boundedOutput(searchOutput, value);
    if (
        result.results.length > topK ||
        result.results.some((item) => item.generationId !== result.generationId)
    )
        throw new ToolRefusal('INVALID_API_RESPONSE');
    return result;
}

/** Validate exact-version metadata and the API-decoded receipt deadline without renewing it. */
export function exactCitation(value: unknown) {
    return boundedOutput(citationOutput, value);
}

/** Retain whole ordered CHILD neighbors from one publication, with no expiry refresh or identity relabeling. */
export function exactContext(
    value: unknown,
    citation: z.infer<typeof citationOutput>,
    input: { receipt: string; before: number; after: number }
) {
    const result = boundedOutput(contextOutput, value);
    const matches = result.passages.filter((item) => item.relation === 'MATCH');
    if (
        citation.source.receipt !== input.receipt ||
        result.source.receipt !== input.receipt ||
        result.anchorChunkId !== citation.chunkId ||
        result.generationId !== citation.generationId ||
        result.documentId !== citation.documentId ||
        result.version !== citation.version ||
        result.source.expiresAt.getTime() !==
            citation.source.expiresAt.getTime() ||
        new Set(result.passages.map((item) => item.chunkId)).size !==
            result.passages.length ||
        matches.length !== 1 ||
        matches[0]?.chunkId !== citation.chunkId ||
        matches[0]?.source.receipt !== input.receipt ||
        result.passages.length > input.before + input.after + 1 ||
        result.passages.filter((item) => item.relation === 'BEFORE').length >
            input.before ||
        result.passages.filter((item) => item.relation === 'AFTER').length >
            input.after ||
        result.passages.some(
            (item, index) =>
                item.generationId !== citation.generationId ||
                item.publicationId !== citation.publicationId ||
                item.documentId !== citation.documentId ||
                item.version !== citation.version ||
                item.source.expiresAt.getTime() !==
                    citation.source.expiresAt.getTime() ||
                (index > 0 &&
                    item.ordinal <=
                        (result.passages[index - 1]?.ordinal ?? -1)) ||
                (item.relation === 'BEFORE' &&
                    item.ordinal >= citation.ordinal) ||
                (item.relation === 'AFTER' &&
                    item.ordinal <= citation.ordinal) ||
                (item.relation === 'MATCH' && item.ordinal !== citation.ordinal)
        )
    )
        throw new ToolRefusal('INVALID_API_RESPONSE');
    return result;
}
