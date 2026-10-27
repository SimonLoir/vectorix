import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id } from './rag/common';
import { documentSource } from './rag/documents';
import { searchInput, searchOutput } from './rag/search-contract';

export const retrievalSource = z
    .object({
        receipt: z.string().min(1).max(4096),
        expiresAt: z.date(),
    })
    .strict();
export const retrievalSourceInput = z
    .object({
        collectionId: id,
        receipt: z.string().min(1).max(4096),
    })
    .strict();
/** Exact immutable publication metadata; offsets use canonical UTF-16 indices. */
export const retrievalCitationMetadata = z
    .object({
        chunkId: id,
        generationId: id,
        publicationId: id,
        documentId: id,
        documentName: z.string(),
        version: z.number().int().positive(),
        ordinal: z.number().int().nonnegative(),
        startOffset: z
            .number()
            .int()
            .nonnegative()
            .max(25 * 1024 * 1024)
            .nullable(),
        endOffset: z
            .number()
            .int()
            .positive()
            .max(25 * 1024 * 1024)
            .nullable(),
        sourceSpans: z
            .array(
                z
                    .object({
                        source: documentSource.strict(),
                        start: z.number().int().nonnegative(),
                        end: z.number().int().nonnegative(),
                    })
                    .strict()
            )
            .max(64),
        sourceSpansTruncated: z.boolean(),
    })
    .strict();
export const retrievalCitation = retrievalCitationMetadata.extend({
    source: retrievalSource,
});
export const retrievalContextInput = retrievalSourceInput.extend({
    before: z.number().int().min(0).max(2).default(1),
    after: z.number().int().min(0).max(2).default(1),
});
export const retrievalPassage = retrievalCitation.extend({
    text: z.string().max(49_152),
    relation: z.enum(['BEFORE', 'MATCH', 'AFTER']),
});
export const retrievalContext = z
    .object({
        anchorChunkId: id,
        generationId: id,
        documentId: id,
        documentName: z.string(),
        version: z.number().int().positive(),
        source: retrievalSource,
        passages: z.array(retrievalPassage).min(1).max(5),
    })
    .strict();

/** External retrieval reuses ordinary search and the same current collection authority. */
export const retrievalContract = {
    search: oc
        .route({ method: 'POST', path: '/collections/{collectionId}/search' })
        .input(searchInput)
        .output(searchOutput),
    citation: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/citations/resolve',
        })
        .input(retrievalSourceInput)
        .output(retrievalCitation),
    context: oc
        .route({ method: 'POST', path: '/collections/{collectionId}/context' })
        .input(retrievalContextInput)
        .output(retrievalContext),
};
