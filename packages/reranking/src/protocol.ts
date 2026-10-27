import { z } from 'zod';
import { RerankingError, type RerankingResult } from './types';
import type { HostedRerankingProvider } from './models';

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const billedUnits = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
const score = z.object({
    index: z.number().int().nonnegative(),
    ['relevance_score']: z.number().min(0).max(1),
});
const cohereResponse = z.object({
    results: z.array(score).min(1).max(100),
    meta: z
        .object({
            tokens: z.object({ ['input_tokens']: tokens.nullish() }).nullish(),
            ['billed_units']: z
                .object({
                    ['input_tokens']: billedUnits.nullish(),
                    ['search_units']: billedUnits.nullish(),
                })
                .nullish(),
        })
        .nullish(),
});
const voyageResponse = z.object({
    object: z.literal('list'),
    model: z.string(),
    data: z.array(score).min(1).max(100),
    usage: z.object({ ['total_tokens']: tokens.nullish() }).nullish(),
});

/** Full cardinality is mandatory; a partial or malformed answer never becomes a ranking. */
export function parseRerankingResponse(
    provider: HostedRerankingProvider,
    model: string,
    count: number,
    response: unknown
): Omit<RerankingResult, 'durationMs'> {
    const parsed =
        provider === 'COHERE'
            ? cohereResponse.safeParse(response)
            : voyageResponse.safeParse(response);
    if (!parsed.success) throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    const data = parsed.data;
    if ('model' in data && data.model !== model)
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    const results = 'results' in data ? data.results : data.data;
    if (
        results.length !== count ||
        new Set(results.map((result) => result.index)).size !== count ||
        results.some((result) => result.index >= count)
    )
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    return {
        results: results
            .map((result) => ({
                index: result.index,
                score: result.relevance_score,
            }))
            .toSorted(
                (left, right) =>
                    right.score - left.score || left.index - right.index
            ),
        usage:
            'results' in data
                ? {
                      providerInputTokens:
                          data.meta?.tokens?.input_tokens ?? null,
                      billedInputTokens:
                          data.meta?.billed_units?.input_tokens ?? null,
                      billedSearchUnits:
                          data.meta?.billed_units?.search_units ?? null,
                  }
                : {
                      providerInputTokens: data.usage?.total_tokens ?? null,
                      billedInputTokens: null,
                      billedSearchUnits: null,
                  },
    };
}
