import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor } from '../access';
import { rerankLimits, utcDay } from './limits';
import { isRerankingProvider } from './configuration';
import { rerankError } from './errors';
import { rerankSummary } from '@repo/api-contracts/v1/rag/reranking';
import { extendedRerankSummary } from '@repo/api-contracts/v1/rag/reranking-extended';

/** Return only numeric UTC-day totals; unknown native billing is never represented as zero. */
async function usageInternal(context: AuthorizedContext, extended: boolean) {
    const actor = await ragActor(context, context.db, { ragQuota: ['read'] });
    const start = utcDay();
    const rows = await context.db.rerankUsageDay.findMany({
        where: {
            organizationId: actor.organizationId,
            day: start,
            provider: {
                in: extended
                    ? ['COHERE', 'VOYAGE', 'TEI']
                    : ['COHERE', 'VOYAGE'],
            },
        },
        orderBy: { provider: 'asc' },
        take: extended ? 3 : 2,
    });
    const activeRequests = await context.db.rerankRequest.count({
        where: {
            organizationId: actor.organizationId,
            capacityReleasedAt: null,
            expiresAt: { gt: new Date() },
        },
    });
    return {
        windowStart: start,
        windowEnd: new Date(start.getTime() + 86_400_000),
        limits: rerankLimits(),
        activeRequests,
        usage: rows.map((row) => {
            if (!isRerankingProvider(row.provider))
                throw rerankError('PROFILE_UNSUPPORTED');
            return {
                provider: row.provider,
                dispatchedRequests: String(row.dispatchedRequests),
                dispatchedPreparedBytes: String(row.dispatchedPreparedBytes),
                validatedRequests: String(row.validatedRequests),
                validatedDocuments: String(row.validatedDocuments),
                knownProviderInputTokens: String(row.knownProviderInputTokens),
                unknownProviderInputTokenRequests: String(
                    row.unknownProviderInputTokenRequests
                ),
                knownBilledInputTokens: row.knownBilledInputTokens,
                unknownBilledInputTokenRequests: String(
                    row.unknownBilledInputTokenRequests
                ),
                knownBilledSearchUnits: row.knownBilledSearchUnits,
                unknownBilledSearchUnitRequests: String(
                    row.unknownBilledSearchUnitRequests
                ),
                observedNativeDurationMicros: String(
                    row.observedNativeDurationMicros
                ),
            };
        }),
    };
}

/** Legacy usage lists only its two known providers; active organization capacity still includes every engine. */
export async function rerankUsage(context: AuthorizedContext) {
    return rerankSummary.parse(await usageInternal(context, false));
}

/** Extended usage uses open identifiers while retaining decimal counters and unknown-versus-zero semantics. */
export async function extendedRerankUsage(context: AuthorizedContext) {
    return extendedRerankSummary.parse(await usageInternal(context, true));
}
