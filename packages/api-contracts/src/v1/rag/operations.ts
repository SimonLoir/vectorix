import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id } from './common';

export const operationCategory = z.enum([
    'INGESTION',
    'DOCUMENT_CLEANUP',
    'INDEXING',
]);
export const operationState = z.enum([
    'UPLOADING',
    'DUE',
    'SCHEDULED',
    'LEASED',
    'EXPIRED',
    'FAILED',
]);
const count = z.number().int().nonnegative();

/** Current durable work, without inferring execution time or worker liveness. */
export const operationCounts = z.object({
    category: operationCategory,
    uploading: count,
    due: count,
    scheduled: count,
    leased: count,
    expired: count,
    failed: count,
    total: count,
    oldestAcceptedAt: z.date().nullable(),
});
export const operationsSummary = z.object({
    observedAt: z.date(),
    counts: z.array(operationCounts).max(3),
});

export const operationsInput = z
    .object({
        category: operationCategory.default('INDEXING'),
        state: z.union([z.literal('ALL'), operationState]).default('ALL'),
        query: z.string().trim().max(200).default(''),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(25),
    })
    .strict()
    .prefault({});

/** A link opens an existing guarded recovery screen; it never grants a retry. */
export const operationItem = z.object({
    id,
    category: operationCategory,
    kind: z.enum([
        'INGESTION',
        'DOCUMENT_CLEANUP',
        'PROVISION',
        'INDEX_DOCUMENT',
        'REMOVE_DOCUMENT',
        'CLEAN_PUBLICATION',
        'CLEAN_GENERATION',
    ]),
    status: z.enum(['UPLOADING', 'PENDING', 'PROCESSING', 'FAILED']),
    state: operationState,
    name: z.string().max(512),
    version: z.number().int().positive().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
    availableAt: z.date(),
    leasedUntil: z.date().nullable(),
    attempts: count,
    errorCode: z.string().max(64).nullable(),
    target: z.object({
        type: z.enum(['DOCUMENT', 'COLLECTION']),
        id,
        deleted: z.boolean(),
    }),
});

export const operationsContract = {
    overview: oc
        .route({
            method: 'GET',
            path: '/operations',
            description:
                'Read current organization work and authorized recovery links; current sessions with quota-read permission only',
        })
        .input(operationsInput)
        .output(
            operationsSummary.extend({
                items: z.array(operationItem).max(100),
                visibleTotal: count,
            })
        ),
};
