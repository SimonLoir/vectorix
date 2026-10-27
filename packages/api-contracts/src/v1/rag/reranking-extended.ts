import { oc } from '@orpc/contract';
import { z } from 'zod';
import { empty, id, page, success } from './common';
import { searchInput, searchOutput } from './search-contract';
import { searchResult } from './indexing-types';
import { rerankProfileView, rerankSummary, rerankUsage } from './reranking';

// Open identifiers deliberately preserve future engine additions without widening
// any of the revision-22 closed hosted-provider DTOs.
export const rerankEngineId = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
export const rerankRuntimeSnapshot = z
    .object({
        protocolVersion: z.string().min(1).max(64),
        modelId: z.string().min(1).max(200),
        modelRevision: z.string().min(1).max(128).nullable(),
        modelType: z.string().min(1).max(64),
        maxInputLength: z.number().int().min(1).max(10_000_000),
        maxClientBatchSize: z.number().int().min(1).max(100_000),
        runtimeVersion: z.string().min(1).max(64),
        modelDtype: z.string().min(1).max(64),
    })
    .strict();
export const extendedRerankProfile = rerankProfileView.extend({
    configuration: z
        .object({
            provider: rerankEngineId,
            model: z.string().min(1).max(200),
            candidatePool: z.number().int().min(1).max(100),
            bindingSource: z.enum(['ORGANIZATION', 'PLATFORM', 'UNBOUND']),
            createdAt: z.date(),
            runtimeSnapshot: rerankRuntimeSnapshot.nullable(),
        })
        .strict()
        .nullable(),
});
export const configureExtendedRerankInput = z
    .object({
        collectionId: id,
        expectedRevision: z.number().int().nonnegative(),
        enabled: z.boolean(),
        provider: rerankEngineId,
        model: z.string().trim().min(1).max(200),
        candidatePool: z.number().int().min(1).max(100).default(50),
    })
    .strict();
export const extendedRerankSearchOutput = searchOutput.extend({
    results: z
        .array(searchResult.extend({ rerankScore: z.number().finite() }))
        .max(50),
    reranking: z
        .object({
            revision: z.number().int().positive(),
            provider: rerankEngineId,
            model: z.string().min(1).max(200),
            scoreKind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            candidateLimit: z.number().int().min(1).max(100),
            candidateCount: z.number().int().min(0).max(100),
            rerankedCount: z.number().int().min(0).max(100),
            durationMs: z.number().nonnegative(),
            underfilled: z.boolean(),
            usage: rerankUsage,
            attemptId: id,
        })
        .strict(),
    comparison: searchOutput.optional(),
});
export const extendedRerankSummary = rerankSummary.extend({
    usage: z
        .array(
            rerankSummary.shape.usage.element.extend({
                provider: rerankEngineId,
            })
        )
        .max(50),
});

export const extendedRerankingContract = {
    profile: oc
        .route({
            method: 'GET',
            path: '/collections/{collectionId}/reranking-profile',
        })
        .input(z.object({ collectionId: id }).strict())
        .output(extendedRerankProfile),
    configure: oc
        .route({
            method: 'PUT',
            path: '/collections/{collectionId}/reranking-profile',
        })
        .input(configureExtendedRerankInput)
        .output(extendedRerankProfile),
    search: oc
        .route({
            method: 'POST',
            path: '/collections/{collectionId}/reranking-search',
        })
        .input(
            searchInput.extend({
                requestId: z.uuid(),
                expectedRerankRevision: z.number().int().positive(),
                compare: z.boolean().default(false),
            })
        )
        .output(extendedRerankSearchOutput),
    usage: oc
        .route({ method: 'GET', path: '/reranking/extended-usage' })
        .input(empty)
        .output(extendedRerankSummary),
};

const endpoint = z
    .url()
    .max(2048)
    .refine((value) => {
        const url = new URL(value);
        return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
        );
    }, 'Use a root HTTP(S) endpoint without user information, query or fragment.');
const secret = z
    .string()
    .min(1)
    .max(8192)
    .refine(
        (value) =>
            value.trim().length > 0 &&
            value !== '********' &&
            ![...value].some((character) => {
                const code = character.codePointAt(0)!;
                return code < 32 || code === 127;
            })
    );
export const rerankEndpointView = z
    .object({
        id,
        name: z.string().min(1).max(100),
        provider: rerankEngineId,
        revision: z.number().int().positive(),
        endpoint,
        apiKey: z.literal('********').nullable(),
        active: z.boolean(),
        createdAt: z.date(),
        updatedAt: z.date(),
    })
    .strict();
export const rerankEndpointsContract = {
    list: oc
        .route({ method: 'GET', path: '/reranking/endpoints' })
        .input(page)
        .output(
            z
                .object({
                    items: z.array(rerankEndpointView).max(100),
                    total: z.number().int().nonnegative(),
                })
                .strict()
        ),
    create: oc
        .route({ method: 'POST', path: '/reranking/endpoints' })
        .input(
            z
                .object({
                    name: z.string().trim().min(1).max(100),
                    provider: rerankEngineId,
                    endpoint,
                    apiKey: secret.nullable(),
                    activate: z.boolean().default(true),
                })
                .strict()
        )
        .output(rerankEndpointView),
    update: oc
        .route({ method: 'PUT', path: '/reranking/endpoints/{id}' })
        .input(
            z
                .object({
                    id,
                    expectedRevision: z.number().int().positive(),
                    name: z.string().trim().min(1).max(100),
                    endpoint,
                    apiKey: secret.nullable().optional(),
                })
                .strict()
        )
        .output(rerankEndpointView),
    activate: oc
        .route({ method: 'PUT', path: '/reranking/endpoints/{id}/active' })
        .input(
            z
                .object({ id, expectedRevision: z.number().int().positive() })
                .strict()
        )
        .output(success),
    remove: oc
        .route({ method: 'DELETE', path: '/reranking/endpoints/{id}' })
        .input(
            z
                .object({ id, expectedRevision: z.number().int().positive() })
                .strict()
        )
        .output(success),
};
