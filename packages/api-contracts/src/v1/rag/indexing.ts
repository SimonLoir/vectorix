import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, page, success } from './common';
import { documentSource } from './documents';
import { collectionView } from './collections';
import {
    dimensionCapability,
    verifiedEmbedding,
    indexFailure,
    indexGeneration,
    indexTask,
    chunkView,
    contentLanguage,
    documentMetadata,
    documentTags,
    searchFilters,
    searchResult,
} from './indexing-types';

const reference = z.object({ collectionId: id }).strict();
const sourceInput = reference.extend({ receipt: z.string().min(1).max(4096) });
export const indexingContract = {
    trash: oc
        .route({ method: 'GET', path: '/index-trash' })
        .input(page)
        .output(
            z.object({
                items: z
                    .array(
                        z.object({
                            id,
                            name: z.string(),
                            deletedAt: z.date(),
                            pendingTasks: z.number().int().nonnegative(),
                            failedTasks: z.number().int().nonnegative(),
                        })
                    )
                    .max(100),
                total: z.number().int().nonnegative(),
            })
        ),
    models: oc
        .route({
            method: 'GET',
            path: '/collections/{collectionId}/embedding-models',
        })
        .input(
            reference.extend({
                expectedRevision: z.number().int().positive().optional(),
            })
        )
        .output(
            z.object({
                items: z
                    .array(
                        z.object({
                            model: z.string(),
                            digest: z.string(),
                            family: z.string(),
                            identityKind: z
                                .enum(['WEIGHTS_DIGEST', 'CAPABILITY_PROFILE'])
                                .optional(),
                            supportedDimensions: z
                                .array(z.number().int().positive())
                                .max(16)
                                .optional(),
                            dimensionCapability: dimensionCapability.optional(),
                            defaultDimensions: z
                                .number()
                                .int()
                                .positive()
                                .optional(),
                            contextTokens: z
                                .number()
                                .int()
                                .positive()
                                .optional(),
                        })
                    )
                    .max(100),
                discoverySource: z
                    .enum(['LOCAL_RUNTIME', 'HOSTED_CATALOG'])
                    .optional(),
                reviewedCatalog: z
                    .boolean()
                    .describe(
                        'A reviewed local capability catalog; listing does not test provider access.'
                    )
                    .optional(),
            })
        ),
    probe: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/embedding-probe',
        })
        .input(
            reference.extend({ expectedRevision: z.number().int().positive() })
        )
        .output(verifiedEmbedding),
    start: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/index-generations',
        })
        .input(
            reference.extend({
                expectedRevision: z.number().int().positive(),
                requestId: z.uuid(),
            })
        )
        .output(z.object({ generationId: id })),
    rebuild: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/index-rebuilds',
        })
        .input(
            reference.extend({
                expectedRevision: z.number().int().positive(),
                expectedActiveGenerationId: id,
                requestId: z.uuid(),
            })
        )
        .output(z.object({ generationId: id })),
    discard: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/index-generations/{generationId}/discard',
        })
        .input(reference.extend({ generationId: id }))
        .output(success),
    status: oc
        .route({
            method: 'GET',
            path: '/collections/{collectionId}/index-status',
        })
        .input(reference)
        .output(
            z.object({
                configurationRevision: z.number().int(),
                deletedAt: z.date().nullable(),
                canManage: z.boolean(),
                canRead: z.boolean(),
                canRebuild: z.boolean(),
                rebuildBlockedReason: indexFailure.nullable(),
                activeConfiguration:
                    collectionView.shape.configuration.nullable(),
                unsupportedReason: indexFailure.nullable(),
                active: indexGeneration.nullable(),
                generations: z.array(indexGeneration).max(10),
                usage: z.object({
                    activeChunks: z.number().int().nonnegative(),
                    retainedChunks: z.number().int().nonnegative(),
                    reservedChunks: z.number().int().nonnegative(),
                    activeLimit: z.number().int().nonnegative(),
                    temporaryLimit: z.number().int().nonnegative(),
                }),
            })
        ),
    tasks: oc
        .route({
            method: 'GET',
            path: '/collections/{collectionId}/index-tasks',
        })
        .input(page.unwrap().extend({ collectionId: id }))
        .output(
            z.object({
                items: z.array(indexTask).max(100),
                total: z.number().int(),
            })
        ),
    retry: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/index-tasks/{taskId}/retry',
        })
        .input(reference.extend({ taskId: id }))
        .output(success),
    documents: oc
        .route({
            method: 'GET',
            path: '/collections/{collectionId}/index-documents',
        })
        .input(page.unwrap().extend({ collectionId: id }))
        .output(
            z.object({
                items: z
                    .array(
                        z.object({
                            documentId: id,
                            name: z.string(),
                            mediaType: z.string(),
                            libraryVersion: z.number().int().nullable(),
                            indexedVersion: z.number().int().nullable(),
                            metadataRevision: z.number().int(),
                            language: contentLanguage,
                            tags: documentTags,
                            metadata: documentMetadata,
                            pending: z.boolean(),
                            errorCode: indexFailure.nullable(),
                        })
                    )
                    .max(100),
                total: z.number().int(),
            })
        ),
    updateMetadata: oc
        .route({
            method: 'PUT',
            path: '/collections/{collectionId}/documents/{documentId}/metadata',
        })
        .input(
            reference.extend({
                documentId: id,
                expectedMetadataRevision: z.number().int().positive(),
                language: contentLanguage,
                tags: documentTags,
                metadata: documentMetadata,
            })
        )
        .output(success),
    chunks: oc
        .route({ method: 'GET', path: '/collections/{collectionId}/chunks' })
        .input(
            page.unwrap().extend({
                collectionId: id,
                documentId: id.optional(),
                publicationId: id.optional(),
                generationId: id.optional(),
            })
        )
        .output(
            z.object({
                items: z.array(chunkView).max(100),
                total: z.number().int(),
            })
        ),
    search: oc
        .route({ method: 'POST', path: '/collections/{collectionId}/search' })
        .input(
            reference.extend({
                query: z.string().trim().min(1).max(4000),
                topK: z.number().int().min(1).max(50).default(10),
                strategy: z
                    .enum(['HYBRID', 'LEXICAL', 'VECTOR'])
                    .default('HYBRID'),
                filters: searchFilters,
            })
        )
        .output(
            z.object({
                generationId: id,
                model: z.string(),
                strategy: z.enum(['HYBRID', 'LEXICAL', 'VECTOR']),
                results: z.array(searchResult).max(50),
                vectorUnderfilled: z.boolean(),
                parentUnderfilled: z
                    .boolean()
                    .describe(
                        'The bounded child candidate window yielded fewer distinct parents than requested; this does not establish corpus exhaustion.'
                    )
                    .optional(),
                durationMs: z.number().nonnegative(),
            })
        ),
    sourcePreview: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/sources/preview',
        })
        .input(
            sourceInput.extend({
                sourceIndex: z.number().int().min(0).max(4999).optional(),
                offset: z
                    .number()
                    .int()
                    .min(0)
                    .max(25 * 1024 * 1024)
                    .default(0),
            })
        )
        .output(
            z.object({
                documentName: z.string(),
                version: z.number().int(),
                format: z.enum(['TEXT', 'MARKDOWN', 'PDF', 'DOCX']),
                source: documentSource,
                totalSources: z.number().int(),
                text: z.string().max(20_000),
                nextOffset: z.number().int().nullable(),
                totalCharacters: z.number().int(),
                empty: z.boolean(),
            })
        ),
    sourceOriginal: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/sources/original',
        })
        .input(sourceInput)
        .output(z.file()),
};
