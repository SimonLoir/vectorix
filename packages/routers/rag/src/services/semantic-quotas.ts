import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { semanticQuotaValues } from '@repo/api-contracts/v1/rag/semantic';

const defaults = {
    semanticUnitsPerDocument: 8192,
    semanticPlanBytesPerDocument: 1_048_576,
    semanticPlanBytesPerOrganization: 67_108_864,
    embeddingPreparedBytesPerCandidate: 134_217_728,
    embeddingBatchesPerCandidate: 4096,
    embeddingOutstandingPreparedBytes: 536_870_912,
    embeddingOutstandingBatches: 16_384,
};
const names = {
    semanticUnitsPerDocument: 'SEMANTIC_UNITS_PER_DOCUMENT',
    semanticPlanBytesPerDocument: 'SEMANTIC_PLAN_BYTES_PER_DOCUMENT',
    semanticPlanBytesPerOrganization: 'SEMANTIC_PLAN_BYTES_PER_ORGANIZATION',
    embeddingPreparedBytesPerCandidate:
        'EMBEDDING_PREPARED_BYTES_PER_CANDIDATE',
    embeddingBatchesPerCandidate: 'EMBEDDING_BATCHES_PER_CANDIDATE',
    embeddingOutstandingPreparedBytes: 'EMBEDDING_OUTSTANDING_PREPARED_BYTES',
    embeddingOutstandingBatches: 'EMBEDDING_OUTSTANDING_BATCHES',
} as const;

/** Read separate technical work limits without widening the strict legacy six-field quota DTO. */
export async function semanticQuotaLimits(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const stored = await db.organizationQuota.findUnique({
        where: { organizationId },
    });
    const values = Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => {
            const field = key as keyof typeof defaults;
            const configured =
                process.env[`VECTORIX_DEFAULT_RAG_${names[field]}`];
            return [
                key,
                stored
                    ? Number(stored[field])
                    : configured === undefined
                      ? fallback
                      : Number(configured),
            ];
        })
    );
    const parsed = semanticQuotaValues.safeParse(values);
    if (!parsed.success)
        throw new ORPCError('CONFLICT', {
            message: 'Semantic indexing quota configuration is invalid.',
        });
    return parsed.data;
}

/** Convert only persistence fields that require BIGINT; transport values remain reviewed safe integers. */
export function semanticQuotaPersistence(
    limits: typeof semanticQuotaValues._output
) {
    return {
        ...limits,
        semanticPlanBytesPerOrganization: BigInt(
            limits.semanticPlanBytesPerOrganization
        ),
        embeddingPreparedBytesPerCandidate: BigInt(
            limits.embeddingPreparedBytesPerCandidate
        ),
        embeddingOutstandingPreparedBytes: BigInt(
            limits.embeddingOutstandingPreparedBytes
        ),
    };
}

/** Cumulative observations cover tracked semantic indexing only; missing native usage stays explicitly unknown. */
export async function semanticQuotaUsage(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const row = await db.organizationEmbeddingAccounting.findUnique({
        where: { organizationId },
    });
    const successful = row?.observedSuccessfulRequests ?? 0n;
    return {
        trackingSince: row?.trackingSince ?? null,
        reservedPlanBytes: String(row?.reservedPlanBytes ?? 0n),
        storedPlanBytes: String(row?.storedPlanBytes ?? 0n),
        reservedPreparedBytes: String(row?.reservedPreparedBytes ?? 0n),
        reservedBatches: String(row?.reservedBatches ?? 0n),
        dispatchedPreparedBytes: String(row?.dispatchedPreparedBytes ?? 0n),
        dispatchedBatches: String(row?.dispatchedBatches ?? 0n),
        confirmedRequests: String(successful),
        estimatedInputTokens: String(row?.observedEstimatedInputTokens ?? 0n),
        providerInputTokens:
            row && successful > row.unknownProviderTokenBatches
                ? String(row.observedProviderInputTokens)
                : null,
        billedInputTokens:
            row && successful > row.unknownBilledTokenBatches
                ? row.observedBilledInputTokens
                : null,
        unknownProviderTokenBatches: String(
            row?.unknownProviderTokenBatches ?? 0n
        ),
        unknownBilledTokenBatches: String(row?.unknownBilledTokenBatches ?? 0n),
        uncertainAttempts: String(row?.uncertainAttempts ?? 0n),
    };
}
