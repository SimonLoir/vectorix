import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, page, empty } from './common';
import { credentialsContract } from './credentials';
import { groupsContract } from './groups';
import { collectionsContract } from './collections';
const document = z.object({
    id,
    name: z.string(),
    status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED', 'DELETED']),
    createdAt: z.date(),
    updatedAt: z.date(),
});
export const quotaValues = z
    .object({
        collections: z.number().int().min(1).max(10_000),
        documents: z.number().int().min(1).max(10_000_000),
        originalBytes: z.number().int().min(1).max(10_737_418_240),
        storageBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        chunksPerCollection: z.number().int().min(1).max(100_000_000),
    })
    .strict();
export const ragContract = {
    credentials: credentialsContract,
    groups: groupsContract,
    collections: collectionsContract,
    documents: {
        list: oc
            .route({ method: 'GET', path: '/documents' })
            .input(page)
            .output(
                z.object({ items: z.array(document), total: z.number().int() })
            ),
        get: oc
            .route({ method: 'GET', path: '/documents/{id}' })
            .input(z.object({ id }).strict())
            .output(document),
    },
    connections: oc
        .route({ method: 'GET', path: '/connections' })
        .input(empty)
        .output(
            z.object({
                items: z.array(
                    z.object({
                        id,
                        name: z.string(),
                        kind: z.literal('PLATFORM_POSTGRESQL'),
                    })
                ),
            })
        ),
    quota: oc
        .route({ method: 'GET', path: '/quota' })
        .input(empty)
        .output(
            z.object({
                limits: quotaValues,
                usage: z.object({
                    collections: z.number().int(),
                    documents: z.number().int(),
                    storageBytes: z.number().int(),
                }),
            })
        ),
    audit: oc
        .route({ method: 'GET', path: '/audit' })
        .input(page)
        .output(
            z.object({
                items: z.array(
                    z.object({
                        id,
                        actorType: z.string(),
                        actorId: z.string(),
                        action: z.string(),
                        targetId: z.string().nullable(),
                        details: z
                            .record(
                                z.string(),
                                z.union([z.string(), z.number(), z.boolean()])
                            )
                            .nullable(),
                        createdAt: z.date(),
                    })
                ),
                total: z.number().int(),
            })
        ),
};
