import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
    id,
    page,
    embeddingProvider,
    grantPermissions,
    success,
    principalPage,
} from './common';
export const collectionProfile = z
    .object({
        provider: embeddingProvider,
        model: z.string().trim().min(1).max(200),
        dimensions: z.number().int().min(1).max(16_000),
        metric: z.literal('cosine').default('cosine'),
        indexType: z.enum(['HNSW', 'DISKANN']).default('DISKANN'),
        numericType: z.literal('float32').default('float32'),
        preparation: z.string().max(4000).default(''),
        chunkingStrategy: z
            .enum(['TOKEN_WINDOW', 'DOCUMENT_STRUCTURE', 'SEMANTIC'])
            .default('DOCUMENT_STRUCTURE'),
        chunking: z
            .object({
                targetTokens: z.number().int().min(32).max(8192).default(512),
                overlapTokens: z.number().int().min(0).max(4096).default(64),
                minTokens: z.number().int().min(1).max(8192).default(128),
                maxTokens: z.number().int().min(32).max(16_384).default(768),
                semanticPercentile: z.number().min(1).max(99).default(90),
                parentMaxTokens: z
                    .number()
                    .int()
                    .min(32)
                    .max(32_768)
                    .default(2048),
            })
            .strict()
            .default({
                targetTokens: 512,
                overlapTokens: 64,
                minTokens: 128,
                maxTokens: 768,
                semanticPercentile: 90,
                parentMaxTokens: 2048,
            }),
        parentChild: z.boolean().default(false),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.indexType === 'HNSW' && value.dimensions > 2000)
            ctx.addIssue({
                code: 'custom',
                message: 'Float32 HNSW supports at most 2000 dimensions.',
            });
        const c = value.chunking;
        if (
            c.overlapTokens >= c.targetTokens ||
            c.minTokens > c.targetTokens ||
            c.targetTokens > c.maxTokens ||
            (value.parentChild && c.parentMaxTokens < c.maxTokens)
        )
            ctx.addIssue({
                code: 'custom',
                message: 'Inconsistent chunk sizes or overlap.',
            });
    });
export const collectionView = z.object({
    id,
    name: z.string(),
    description: z.string(),
    configurationRevision: z.number().int(),
    createdAt: z.date(),
    updatedAt: z.date(),
    permissions: grantPermissions,
    configuration: collectionProfile.safeExtend({
        vectorConnectionId: id,
        credentialId: id.nullable(),
        credentialRevision: z.number().int().nullable(),
    }),
});
const grantTarget = z.discriminatedUnion('type', [
    z.object({ type: z.literal('member'), id }).strict(),
    z.object({ type: z.literal('group'), id }).strict(),
]);
export const collectionsContract = {
    revisions: oc
        .route({ method: 'GET', path: '/collections/{id}/revisions' })
        .input(page.removeDefault().extend({ id }))
        .output(
            z.object({
                items: z.array(
                    z.object({
                        revision: z.number().int(),
                        createdAt: z.date(),
                        configuration: collectionView.shape.configuration,
                    })
                ),
                total: z.number().int(),
            })
        ),
    grantCandidates: oc
        .route({ method: 'GET', path: '/collections/{id}/grant-candidates' })
        .input(
            page
                .removeDefault()
                .extend({ id, type: z.enum(['member', 'group']) })
        )
        .output(principalPage),
    list: oc
        .route({ method: 'GET', path: '/collections' })
        .input(page)
        .output(
            z.object({
                items: z.array(collectionView),
                total: z.number().int(),
            })
        ),
    get: oc
        .route({ method: 'GET', path: '/collections/{id}' })
        .input(z.object({ id }).strict())
        .output(collectionView),
    create: oc
        .route({ method: 'POST', path: '/collections' })
        .input(
            z
                .object({
                    name: z.string().trim().min(1).max(200),
                    description: z.string().max(2000).default(''),
                    profile: collectionProfile,
                    grantCreatorRead: z.boolean().default(true),
                })
                .strict()
        )
        .output(collectionView),
    update: oc
        .route({ method: 'PUT', path: '/collections/{id}' })
        .input(
            z
                .object({
                    id,
                    expectedRevision: z.number().int().positive(),
                    name: z.string().trim().min(1).max(200),
                    description: z.string().max(2000),
                    profile: collectionProfile,
                })
                .strict()
        )
        .output(collectionView),
    delete: oc
        .route({ method: 'DELETE', path: '/collections/{id}' })
        .input(
            z
                .object({ id, expectedRevision: z.number().int().positive() })
                .strict()
        )
        .output(success),
    grants: oc
        .route({ method: 'GET', path: '/collections/{id}/grants' })
        .input(page.removeDefault().extend({ id }))
        .output(
            z.object({
                items: z.array(
                    z.object({
                        target: grantTarget,
                        name: z.string(),
                        permissions: grantPermissions,
                    })
                ),
                total: z.number().int(),
            })
        ),
    setGrant: oc
        .route({ method: 'PUT', path: '/collections/{id}/grants' })
        .input(
            z
                .object({
                    id,
                    target: grantTarget,
                    permissions: grantPermissions,
                })
                .strict()
        )
        .output(success),
    removeGrant: oc
        .route({ method: 'DELETE', path: '/collections/{id}/grants' })
        .input(z.object({ id, target: grantTarget }).strict())
        .output(success),
};
