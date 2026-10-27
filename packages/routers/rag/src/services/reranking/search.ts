import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    rerank,
    RERANKING_LIMITS,
    validateRerankingInput,
    rerankingScoreKind,
    type RerankingResult,
} from '@repo/reranking';
import { searchCollectionWithReranking } from '../indexing/search';
import { remainingSearchMs } from '../indexing/search-reranking';
import type { SearchInput } from '../indexing/search-types';
import { indexError } from '../indexing/errors';
import {
    claimRerankRequest,
    admitRerankDispatch,
    settleRerankValidated,
    settleRerankFailure,
    releaseRerankClaim,
    recheckRerankAuthority,
    type RerankRun,
} from './accounting';
import { resolveRerankConfiguration } from './configuration';
import { safeRerankError } from './errors';
import { rerankingContract } from '@repo/api-contracts/v1/rag/reranking';
import { extendedRerankSearchOutput } from '@repo/api-contracts/v1/rag/reranking-extended';

type RerankedSearchInput = SearchInput & {
    requestId: string;
    expectedRerankRevision: number;
    compare: boolean;
};

/** Extract only a sanitized finite domain code for the mandatory attempt ledger. */
function failureCode(error: ReturnType<typeof safeRerankError>) {
    return error.data &&
        typeof error.data === 'object' &&
        'errorCode' in error.data &&
        typeof error.data.errorCode === 'string'
        ? error.data.errorCode
        : 'PROCESSING_FAILED';
}

/**
 * Claim before query embedding, then rerank one authorized child pool without a
 * second retrieval. Validated usage settles before any post-I/O authority denial;
 * a settlement failure must never be relabeled as an unvalidated native failure.
 */
async function searchWithRerankingInternal(
    context: AuthorizedContext,
    input: RerankedSearchInput,
    extended: boolean
) {
    const startedAt = Date.now();
    // Public search caps count characters; native reranking caps UTF-8 bytes.
    // Reject an oversized query before even the first query embedding can cost.
    if (
        new TextEncoder().encode(input.query).byteLength >
        RERANKING_LIMITS.queryBytes
    )
        throw safeRerankError(indexError('INPUT_TOO_LARGE', 'BAD_REQUEST'));
    let captured: RerankRun;
    try {
        captured = await claimRerankRequest(context, {
            collectionId: input.collectionId,
            requestId: input.requestId,
            expectedRerankRevision: input.expectedRerankRevision,
            hostedOnly: !extended,
        });
    } catch (error) {
        throw safeRerankError(error);
    }
    const outcome = await searchClaimed(
        context,
        input,
        captured,
        startedAt
    ).then(
        (value) => ({ success: true as const, value }),
        (error: unknown) => ({
            success: false as const,
            error: safeRerankError(error),
        })
    );
    try {
        // Only undispatched ADMITTED claims are finalized here. Native
        // settlement owns dispatched requests, including late failures.
        await releaseRerankClaim(context.db, captured);
    } catch (error) {
        // Preserve a primary domain refusal. A cleanup failure must not expose
        // private diagnostics or overwrite the reason the search was denied.
        if (outcome.success) throw safeRerankError(error);
    }
    if (!outcome.success) throw outcome.error;
    return outcome.value;
}

/** Run the captured generation and profile; the public wrapper always releases its claim afterward. */
async function searchClaimed(
    context: AuthorizedContext,
    input: RerankedSearchInput,
    captured: RerankRun,
    startedAt: number
) {
    let nativeResult: RerankingResult | undefined;
    try {
        const execution = await searchCollectionWithReranking(context, input, {
            generationId: captured.generationId,
            candidateLimit: captured.profile.candidatePool,
            compare: input.compare,
            startedAt,
            rank: async ({ candidates, assertCurrent, remainingMs }) => {
                // Empty retrievals have no native usage; the request ID still
                // becomes terminal and cannot replay its query embedding.
                if (!candidates.length) return [];
                let dispatched = false;
                try {
                    const configuration = await resolveRerankConfiguration(
                        context,
                        captured
                    );
                    const payload = {
                        model: captured.profile.model,
                        query: input.query,
                        documents: candidates.map((child) => child.text),
                    };
                    const statistics = validateRerankingInput(
                        configuration.provider,
                        payload
                    );
                    await assertCurrent();
                    await context.admitProviderRequest?.();
                    await recheckRerankAuthority(context, captured);
                    const remaining = remainingMs();
                    nativeResult = await rerank(configuration, payload, {
                        signal: AbortSignal.timeout(remaining),
                        timeoutMs: Math.min(
                            RERANKING_LIMITS.timeoutMs,
                            remaining
                        ),
                        beforeInference: async () => {
                            // TEI metadata may have awaited external I/O. Recheck
                            // content, grants and the live endpoint policy again
                            // before admitting or transmitting candidate texts.
                            await assertCurrent();
                            await recheckRerankAuthority(context, captured);
                            const current = await resolveRerankConfiguration(
                                context,
                                captured
                            );
                            if (
                                current.provider !== configuration.provider ||
                                current.endpoint !== configuration.endpoint ||
                                current.apiKey !== configuration.apiKey
                            )
                                throw indexError(
                                    'CREDENTIALS_INVALID',
                                    'CONFLICT'
                                );
                            await admitRerankDispatch(
                                context,
                                captured,
                                statistics
                            );
                            dispatched = true;
                            await assertCurrent();
                            await recheckRerankAuthority(context, captured);
                            remainingSearchMs(startedAt);
                        },
                    });
                    await settleRerankValidated(
                        context.db,
                        captured,
                        nativeResult
                    );
                    await recheckRerankAuthority(context, captured);
                    return nativeResult.results;
                } catch (error) {
                    const safe = safeRerankError(error);
                    if (dispatched && !nativeResult) {
                        // A timeout or failed send has unknown usage. Do not
                        // invent zero units, and never overwrite validated usage.
                        await settleRerankFailure(
                            context.db,
                            captured,
                            failureCode(safe)
                        );
                    }
                    throw safe;
                }
            },
        });
        await recheckRerankAuthority(context, captured);
        remainingSearchMs(startedAt);
        return {
            ...execution.response,
            results: execution.response.results.map((row) => {
                const rerankScore = execution.rerankScores.get(row.id);
                if (rerankScore === undefined)
                    throw indexError(
                        'INVALID_PROVIDER_RESPONSE',
                        'SERVICE_UNAVAILABLE'
                    );
                return { ...row, rerankScore };
            }),
            reranking: {
                revision: captured.profile.revision,
                provider: captured.profile.provider,
                model: captured.profile.model,
                scoreKind: rerankingScoreKind(captured.profile.provider),
                candidateLimit: captured.profile.candidatePool,
                candidateCount: execution.candidateCount,
                rerankedCount: execution.rerankedCount,
                durationMs: nativeResult?.durationMs ?? 0,
                underfilled: execution.response.results.length < input.topK,
                usage: nativeResult?.usage ?? {
                    providerInputTokens: null,
                    billedInputTokens: null,
                    billedSearchUnits: null,
                },
                attemptId: captured.id,
            },
            ...(execution.comparison
                ? { comparison: execution.comparison }
                : {}),
        };
    } catch (error) {
        throw safeRerankError(error);
    }
}

/** Frozen hosted-only output mapping preserves revision-22 validators and refuses TEI before the cost claim. */
export async function searchWithReranking(
    context: AuthorizedContext,
    input: RerankedSearchInput
) {
    return rerankingContract.search['~orpc'].outputSchema!.parse(
        await searchWithRerankingInternal(context, input, false)
    );
}

/** Extended clients receive explicit engine and score-kind metadata from the same authorized pipeline. */
export async function searchWithExtendedReranking(
    context: AuthorizedContext,
    input: RerankedSearchInput
) {
    return extendedRerankSearchOutput.parse(
        await searchWithRerankingInternal(context, input, true)
    );
}
