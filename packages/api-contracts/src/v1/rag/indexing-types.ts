import { z } from 'zod';
import { id, embeddingProvider } from './common';
import { documentSource } from './documents';

export const indexFailure = z.enum([
    'ACCESS_REVOKED',
    'PROFILE_UNSUPPORTED',
    'CREDENTIALS_INVALID',
    'MODEL_NOT_FOUND',
    'MODEL_UNSUPPORTED',
    'MODEL_CHANGED',
    'DIMENSIONS_UNSUPPORTED',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'PROVIDER_REJECTED',
    'INVALID_PROVIDER_RESPONSE',
    'INPUT_TOO_LARGE',
    'VECTOR_UNAVAILABLE',
    'VECTOR_BINDING_CHANGED',
    'STORAGE_UNAVAILABLE',
    'SOURCE_UNAVAILABLE',
    'CHUNK_LIMIT',
    'QUOTA_EXCEEDED',
    'PROCESSING_FAILED',
    'REBUILD_IN_PROGRESS',
    'GENERATION_CONFLICT',
    'METADATA_INCOMPATIBLE',
]);
export const contentLanguage = z.enum(['FR', 'EN', 'MIXED', 'UNDETERMINED']);
export const metadataKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const metadataFields = z
    .record(metadataKey, z.enum(['STRING', 'NUMBER', 'BOOLEAN', 'DATE']))
    .refine((value) => Object.keys(value).length <= 20);
export const documentMetadata = z
    .record(
        metadataKey,
        z.union([z.string().max(2000), z.number().finite(), z.boolean()])
    )
    .refine((value) => Object.keys(value).length <= 20);
export const documentTags = z.array(z.string().trim().min(1).max(64)).max(20);
export const verifiedEmbedding = z.object({
    provider: embeddingProvider,
    model: z.string(),
    digest: z.string(),
    family: z.string(),
    contextTokens: z.number().int().positive(),
    defaultDimensions: z.number().int().positive(),
    dimensions: z.number().int().positive(),
    supportedDimensions: z.array(z.number().int().positive()).max(16),
    preset: z.enum(['GENERIC', 'EMBEDDING_GEMMA']),
    identityKind: z.enum(['WEIGHTS_DIGEST', 'CAPABILITY_PROFILE']).optional(),
    discoverySource: z.enum(['LOCAL_RUNTIME', 'HOSTED_CATALOG']).optional(),
});
export const indexGeneration = z.object({
    id,
    status: z.enum([
        'PROVISIONING',
        'BUILDING',
        'ACTIVE',
        'FAILED',
        'RETIRED',
        'CLEANING',
        'CLEANED',
    ]),
    configurationRevision: z.number().int(),
    previousGenerationId: id.nullable(),
    model: z.string(),
    dimensions: z.number().int(),
    modelIdentity: z.string(),
    createdAt: z.date(),
    activatedAt: z.date().nullable(),
    retiredAt: z.date().nullable(),
    cleanupAfter: z.date().nullable(),
    projectedChunks: z.number().int().nonnegative(),
    totalDocuments: z.number().int().nonnegative(),
    publishedDocuments: z.number().int().nonnegative(),
    errorCode: indexFailure.nullable(),
});
export const indexTask = z.object({
    id,
    generationId: id,
    publicationId: id.nullable(),
    documentId: id.nullable(),
    kind: z.enum([
        'PROVISION',
        'INDEX_DOCUMENT',
        'REMOVE_DOCUMENT',
        'CLEAN_PUBLICATION',
        'CLEAN_GENERATION',
    ]),
    status: z.enum([
        'PENDING',
        'PROCESSING',
        'COMPLETE',
        'FAILED',
        'CANCELLED',
    ]),
    stage: z.string(),
    attempts: z.number().int(),
    completedChunks: z.number().int(),
    reservedChunks: z.number().int(),
    errorCode: indexFailure.nullable(),
    updatedAt: z.date(),
    retryable: z.boolean(),
});
export const chunkSpan = z.object({
    source: documentSource,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
});
export const chunkView = z.object({
    id,
    generationId: id,
    publicationId: id,
    documentId: id,
    documentName: z.string(),
    version: z.number().int(),
    ordinal: z.number().int(),
    text: z.string().max(49_152),
    tokenCount: z.number().int(),
    tokenCountIsEstimate: z.boolean(),
    language: contentLanguage,
    sourceSpans: z.array(chunkSpan).max(64),
    sourceSpansTruncated: z.boolean(),
    published: z.boolean(),
});
export const searchFilters = z
    .object({
        documentIds: z.array(id).max(100).optional(),
        languages: z.array(contentLanguage).max(4).optional(),
        mediaTypes: z.array(z.string().max(128)).max(5).optional(),
        tags: documentTags.optional(),
        createdAfter: z.date().optional(),
        createdBefore: z.date().optional(),
        metadata: z
            .array(
                z.discriminatedUnion('operator', [
                    z
                        .object({
                            field: metadataKey,
                            operator: z.literal('EQ'),
                            value: z.union([
                                z.string().max(2000),
                                z.number().finite(),
                                z.boolean(),
                            ]),
                        })
                        .strict(),
                    z
                        .object({
                            field: metadataKey,
                            operator: z.literal('IN'),
                            value: z
                                .array(
                                    z.union([
                                        z.string().max(2000),
                                        z.number().finite(),
                                        z.boolean(),
                                    ])
                                )
                                .min(1)
                                .max(20),
                        })
                        .strict(),
                    z
                        .object({
                            field: metadataKey,
                            operator: z.enum(['GTE', 'LTE']),
                            value: z.union([
                                z.number().finite(),
                                z.string().max(64),
                            ]),
                        })
                        .strict(),
                ])
            )
            .max(20)
            .optional(),
    })
    .strict()
    .default({});
export const sourceReference = z.object({
    receipt: z.string().max(4096),
    expiresAt: z.date(),
});
export const searchResult = z.object({
    ...chunkView.shape,
    mediaType: z.string(),
    tags: documentTags,
    metadata: documentMetadata,
    source: sourceReference,
    scores: z.object({
        rrf: z.number(),
        lexicalRank: z.number().int().nullable(),
        vectorRank: z.number().int().nullable(),
        vectorDistance: z.number().nullable(),
    }),
});
