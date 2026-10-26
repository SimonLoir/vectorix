import type { PrismaClient } from '@repo/db';
import type { RerankingResult } from '@repo/reranking';
import { runSerializableTransaction } from '@routers/utils/transactions';
import type { RerankRun } from './accounting-types';
import { rerankFailure } from '@repo/api-contracts/v1/rag/reranking';
import { rerankError } from './errors';

/** Settle validated late native usage before authority denial; expiration releases capacity but cannot discard usage. */
export async function settleRerankValidated(
    db: PrismaClient,
    run: RerankRun,
    result: RerankingResult
) {
    await runSerializableTransaction(db, async (tx) => {
        const row = await tx.rerankRequest.findFirst({
            where: {
                id: run.id,
                organizationId: run.organizationId,
                principalId: run.principalId,
            },
        });
        if (!row) throw rerankError('RERANK_REQUEST_REPLAY');
        if (row.state === 'VALIDATED') return;
        if (
            row.provider !== run.profile.provider ||
            row.configurationId !== run.profile.id ||
            row.collectionId !== run.collectionId
        )
            throw rerankError('RERANK_REQUEST_REPLAY');
        if (
            !row.dispatchDay ||
            !['DISPATCHED', 'UNCERTAIN', 'FAILED'].includes(row.state)
        )
            throw rerankError('RERANK_REQUEST_REPLAY');
        const { providerInputTokens, billedInputTokens, billedSearchUnits } =
            result.usage;
        const duration = BigInt(Math.round(result.durationMs * 1000));
        await tx.rerankUsageDay.update({
            where: {
                ['organizationId_day_provider']: {
                    organizationId: run.organizationId,
                    day: row.dispatchDay,
                    provider: row.provider,
                },
            },
            data: {
                validatedRequests: { increment: 1n },
                validatedDocuments: { increment: BigInt(row.candidateCount) },
                observedNativeDurationMicros: { increment: duration },
                ...(providerInputTokens === null
                    ? {}
                    : {
                          knownProviderInputTokens: {
                              increment: BigInt(providerInputTokens),
                          },
                          unknownProviderInputTokenRequests: { decrement: 1n },
                      }),
                ...(billedInputTokens === null
                    ? {}
                    : {
                          knownBilledInputTokens: {
                              increment: billedInputTokens,
                          },
                          unknownBilledInputTokenRequests: { decrement: 1n },
                      }),
                ...(billedSearchUnits === null
                    ? {}
                    : {
                          knownBilledSearchUnits: {
                              increment: billedSearchUnits,
                          },
                          unknownBilledSearchUnitRequests: { decrement: 1n },
                      }),
            },
        });
        await tx.rerankRequest.update({
            where: { id: row.id },
            data: {
                state: 'VALIDATED',
                completedAt: new Date(),
                capacityReleasedAt: row.capacityReleasedAt ?? new Date(),
                providerInputTokens:
                    providerInputTokens === null
                        ? null
                        : BigInt(providerInputTokens),
                billedInputTokens,
                billedSearchUnits,
                nativeDurationMicros: duration,
                errorCode: null,
            },
        });
    });
}

/** Failure settlement is idempotent, never overwrites validated usage and never retries a provider. */
export async function settleRerankFailure(
    db: PrismaClient,
    run: RerankRun,
    errorCode: string
) {
    await db.rerankRequest.updateMany({
        where: {
            id: run.id,
            organizationId: run.organizationId,
            principalId: run.principalId,
            state: { in: ['ADMITTED', 'DISPATCHED'] },
        },
        data: {
            state: 'FAILED',
            completedAt: new Date(),
            capacityReleasedAt: new Date(),
            errorCode: rerankFailure.safeParse(errorCode).success
                ? errorCode
                : 'PROCESSING_FAILED',
        },
    });
}

/** Only unused claims can be released here. A dispatched or validated call must keep its durable settlement. */
export async function releaseRerankClaim(db: PrismaClient, run: RerankRun) {
    await db.rerankRequest.updateMany({
        where: {
            id: run.id,
            organizationId: run.organizationId,
            principalId: run.principalId,
            state: 'ADMITTED',
        },
        data: {
            state: 'SKIPPED',
            completedAt: new Date(),
            capacityReleasedAt: new Date(),
        },
    });
}
