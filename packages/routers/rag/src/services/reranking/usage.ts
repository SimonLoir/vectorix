import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor } from '../access';
import { rerankLimits, utcDay } from './limits';

/** Return only numeric UTC-day totals; unknown native billing is never represented as zero. */
export async function rerankUsage(context: AuthorizedContext) {
    const actor = await ragActor(context, context.db, { ragQuota: ['read'] });
    const start = utcDay();
    const rows = await context.db.rerankUsageDay.findMany({
        where: {
            organizationId: actor.organizationId,
            day: start,
            provider: { in: ['COHERE', 'VOYAGE'] },
        },
        orderBy: { provider: 'asc' },
        take: 2,
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
        usage: rows.map((row) => ({
            provider: row.provider as 'COHERE' | 'VOYAGE',
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
        })),
    };
}
