import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, empty } from './common';
import { indexFailure, searchResult } from './indexing-types';
import { searchInput, searchOutput } from './search-contract';

export const rerankProvider = z.enum(['COHERE', 'VOYAGE']);
export const rerankFailure = z.enum([
    ...indexFailure.options,
    'RERANK_DISABLED',
    'RERANK_PROFILE_CHANGED',
    'RERANK_REQUEST_REPLAY',
    'RERANK_CAPACITY',
    'RERANK_DAILY_LIMIT',
    'RERANK_INPUT_INVALID',
]);
export const rerankUsage = z
    .object({
        providerInputTokens: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .nullable(),
        billedInputTokens: z.number().finite().nonnegative().nullable(),
        billedSearchUnits: z.number().finite().nonnegative().nullable(),
    })
    .strict();
export const rerankPolicyValues = z
    .object({
        requestsPerDay: z.number().int().min(1).max(10_000),
        preparedBytesPerDay: z.number().int().min(1).max(10_737_418_240),
        concurrentRequests: z.number().int().min(1).max(32),
    })
    .strict();
export const rerankProfileView = z.object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    configuration: z
        .object({
            provider: rerankProvider,
            model: z.string().min(1).max(200),
            candidatePool: z.number().int().min(1).max(100),
            bindingSource: z.enum(['ORGANIZATION', 'PLATFORM', 'UNBOUND']),
            createdAt: z.date(),
        })
        .nullable(),
    canManage: z.boolean(),
    canUse: z.boolean(),
});
const counter = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const rerankSummary = z.object({
    windowStart: z.date(),
    windowEnd: z.date(),
    limits: rerankPolicyValues,
    activeRequests: z.number().int().nonnegative(),
    usage: z
        .array(
            z.object({
                provider: rerankProvider,
                dispatchedRequests: counter,
                dispatchedPreparedBytes: counter,
                validatedRequests: counter,
                validatedDocuments: counter,
                knownProviderInputTokens: counter,
                unknownProviderInputTokenRequests: counter,
                knownBilledInputTokens: z.number().finite().nonnegative(),
                unknownBilledInputTokenRequests: counter,
                knownBilledSearchUnits: z.number().finite().nonnegative(),
                unknownBilledSearchUnitRequests: counter,
                observedNativeDurationMicros: counter,
            })
        )
        .max(2),
});
export const rerankingContract = {
    profile: oc
        .route({ method: 'GET', path: '/collections/{collectionId}/reranking' })
        .input(z.object({ collectionId: id }))
        .output(rerankProfileView),
    configure: oc
        .route({ method: 'PUT', path: '/collections/{collectionId}/reranking' })
        .input(
            z.object({
                collectionId: id,
                expectedRevision: z.number().int().nonnegative(),
                enabled: z.boolean(),
                provider: rerankProvider,
                model: z.string().trim().min(1).max(200),
                candidatePool: z.number().int().min(1).max(100).default(50),
            })
        )
        .output(rerankProfileView),
    search: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/reranked-search',
        })
        .input(
            searchInput.extend({
                requestId: z.uuid(),
                expectedRerankRevision: z.number().int().positive(),
                compare: z.boolean().default(false),
            })
        )
        .output(
            searchOutput.extend({
                results: z
                    .array(
                        searchResult.extend({
                            rerankScore: z.number().finite().min(0).max(1),
                        })
                    )
                    .max(50),
                reranking: z.object({
                    revision: z.number().int().positive(),
                    provider: rerankProvider,
                    model: z.string(),
                    candidateLimit: z.number().int().min(1).max(100),
                    candidateCount: z.number().int().min(0).max(100),
                    rerankedCount: z.number().int().min(0).max(100),
                    durationMs: z.number().nonnegative(),
                    underfilled: z.boolean(),
                    usage: rerankUsage,
                    attemptId: id,
                }),
                comparison: searchOutput.optional(),
            })
        ),
    usage: oc
        .route({ method: 'GET', path: '/reranking/usage' })
        .input(empty)
        .output(rerankSummary),
};
