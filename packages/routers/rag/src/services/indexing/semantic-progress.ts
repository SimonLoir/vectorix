import type { Prisma } from '@repo/db';
import type { semanticTaskProgress as semanticProgressDto } from '@repo/api-contracts/v1/rag/semantic';

type Progress = Omit<typeof semanticProgressDto._output, 'continuations'>;

/** Aggregate bounded task candidates in SQL; no unit text, checkpoint or vector leaves this read. */
export async function semanticTaskProgress(
    db: Prisma.TransactionClient,
    organizationId: string,
    candidateIds: string[]
): Promise<Map<string, Progress>> {
    if (!candidateIds.length) return new Map();
    const [plans, attempts] = await Promise.all([
        db.semanticChunkPlan.findMany({
            where: { organizationId, indexedDocumentId: { in: candidateIds } },
            select: {
                indexedDocumentId: true,
                unitCount: true,
                completedUnits: true,
                state: true,
                reservedPreparedBytes: true,
                reservedBatches: true,
            },
            take: candidateIds.length,
        }),
        db.embeddingWorkAttempt.groupBy({
            by: ['indexedDocumentId', 'state'],
            where: { organizationId, indexedDocumentId: { in: candidateIds } },
            _sum: {
                reservedPreparedBytes: true,
                reservedBatches: true,
                estimatedInputTokens: true,
                providerInputTokens: true,
                billedInputTokens: true,
            },
            _count: {
                _all: true,
                providerInputTokens: true,
                billedInputTokens: true,
            },
        }),
    ]);
    return new Map(
        plans.map((plan) => {
            const work = attempts.filter(
                (row) => row.indexedDocumentId === plan.indexedDocumentId
            );
            const confirmed = work.find((row) => row.state === 'SUCCEEDED');
            return [
                plan.indexedDocumentId,
                {
                    unitCount: plan.unitCount,
                    completedUnits: plan.completedUnits,
                    sealed: plan.state === 'READY',
                    reservedPreparedBytes: String(
                        work.reduce(
                            (sum, row) =>
                                sum + (row._sum.reservedPreparedBytes ?? 0n),
                            plan.reservedPreparedBytes
                        )
                    ),
                    reservedBatches: work.reduce(
                        (sum, row) => sum + (row._sum.reservedBatches ?? 0),
                        plan.reservedBatches
                    ),
                    confirmedBatches: confirmed?._count._all ?? 0,
                    uncertainBatches:
                        work.find((row) => row.state === 'UNCERTAIN')?._count
                            ._all ?? 0,
                    estimatedInputTokens: String(
                        confirmed?._sum.estimatedInputTokens ?? 0n
                    ),
                    providerInputTokens: confirmed?._count.providerInputTokens
                        ? String(confirmed._sum.providerInputTokens ?? 0n)
                        : null,
                    billedInputTokens: confirmed?._count.billedInputTokens
                        ? (confirmed._sum.billedInputTokens ?? 0)
                        : null,
                },
            ];
        })
    );
}
