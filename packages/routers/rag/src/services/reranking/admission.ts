import type { Prisma } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { ragActor, requireCollection } from '../access';
import { normalizeCatalogMutationError } from '../mutation';
import { rerankError } from './errors';
import { rerankLimits, utcDay } from './limits';
import type { RerankRun } from './accounting-types';
import {
    isRerankingProvider,
    isHostedRerankingProvider,
    supportsRerankConfiguration,
} from './configuration';

/** Current issuer, collection grants and profile revision are rechecked inside cost transactions. */
export async function rerankAuthority(
    context: AuthorizedContext,
    collectionId: string,
    expectedRevision: number,
    db: Prisma.TransactionClient = context.db
) {
    const actor = await ragActor(context, db, {
        ragCollection: ['read'],
        ragLibrary: ['read'],
        ragRerank: ['use'],
    });
    const collection = await requireCollection(db, actor, collectionId, 'read');
    const profile = await db.collectionRerankConfig.findFirst({
        where: { organizationId: actor.organizationId, collectionId },
        orderBy: { revision: 'desc' },
    });
    if (!profile?.enabled) throw rerankError('RERANK_DISABLED');
    if (profile.revision !== expectedRevision)
        throw rerankError('RERANK_PROFILE_CHANGED');
    if (
        !isRerankingProvider(profile.provider) ||
        !profile.endpoint ||
        !supportsRerankConfiguration(profile)
    )
        throw rerankError('CREDENTIALS_INVALID');
    return {
        actor,
        collection,
        profile: {
            ...profile,
            provider: profile.provider,
            endpoint: profile.endpoint,
        },
    };
}

/** A single organization lock serializes only database admission, never network I/O. Active capacity is derived from unexpired receipts, so collection deletion cannot leak slots. */
async function lockOrganization(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    await db.organizationRerankAccounting.upsert({
        where: { organizationId },
        create: { organizationId },
        update: { lockRevision: { increment: 1n } },
    });
}

/** Reserve a unique retained request before query embedding; replay never repeats either provider cost. */
export async function claimRerankRequest(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        requestId: string;
        expectedRerankRevision: number;
        hostedOnly?: boolean;
    }
): Promise<RerankRun> {
    try {
        return await runSerializableTransaction(context.db, async (db) => {
            const { actor, collection, profile } = await rerankAuthority(
                context,
                input.collectionId,
                input.expectedRerankRevision,
                db
            );
            if (
                input.hostedOnly &&
                !isHostedRerankingProvider(profile.provider)
            )
                throw rerankError('PROFILE_UNSUPPORTED');
            const principalId = actor.keyId
                ? `key:${actor.keyId}`
                : `user:${actor.userId}`;
            await lockOrganization(db, actor.organizationId);
            if (
                await db.rerankRequest.findUnique({
                    where: {
                        ['organizationId_principalId_requestId']: {
                            organizationId: actor.organizationId,
                            principalId,
                            requestId: input.requestId.toLowerCase(),
                        },
                    },
                })
            )
                throw rerankError('RERANK_REQUEST_REPLAY');
            const limits = rerankLimits();
            const now = new Date();
            const daily = await db.rerankUsageDay.aggregate({
                where: {
                    organizationId: actor.organizationId,
                    day: utcDay(now),
                },
                _sum: { dispatchedRequests: true },
            });
            if (
                (daily._sum.dispatchedRequests ?? 0n) >=
                BigInt(limits.requestsPerDay)
            )
                throw rerankError('RERANK_DAILY_LIMIT');
            const active = await db.rerankRequest.count({
                where: {
                    organizationId: actor.organizationId,
                    capacityReleasedAt: null,
                    expiresAt: { gt: now },
                },
            });
            if (
                active >= limits.concurrentRequests ||
                (await db.rerankRequest.count({
                    where: { organizationId: actor.organizationId },
                })) >= 5000
            )
                throw rerankError('RERANK_CAPACITY');
            const generation = collection.activeGenerationId
                ? await db.indexGeneration.findFirst({
                      where: {
                          id: collection.activeGenerationId,
                          organizationId: actor.organizationId,
                          collectionId: collection.id,
                          status: 'ACTIVE',
                      },
                  })
                : null;
            if (!generation) throw rerankError('GENERATION_CONFLICT');
            const row = await db.rerankRequest.create({
                data: {
                    organizationId: actor.organizationId,
                    collectionId: collection.id,
                    configurationId: profile.id,
                    provider: profile.provider,
                    generationId: generation.id,
                    principalId,
                    requestId: input.requestId.toLowerCase(),
                    expiresAt: new Date(now.getTime() + 120_000),
                },
            });
            return {
                id: row.id,
                organizationId: actor.organizationId,
                collectionId: collection.id,
                generationId: generation.id,
                principalId,
                profile,
            };
        });
    } catch (error) {
        throw normalizeCatalogMutationError(error);
    }
}

/** Persist conservative dispatch intent exactly once immediately before native I/O. Failed or ambiguous calls keep their daily debit. */
export async function admitRerankDispatch(
    context: AuthorizedContext,
    run: RerankRun,
    input: { candidateCount: number; preparedInputBytes: number }
) {
    if (
        !Number.isSafeInteger(input.candidateCount) ||
        input.candidateCount < 1 ||
        input.candidateCount > 100 ||
        !Number.isSafeInteger(input.preparedInputBytes) ||
        input.preparedInputBytes < 1 ||
        input.preparedInputBytes > 512_000
    )
        throw rerankError('INPUT_TOO_LARGE');
    await runSerializableTransaction(context.db, async (db) => {
        const { profile } = await rerankAuthority(
            context,
            run.collectionId,
            run.profile.revision,
            db
        );
        if (profile.id !== run.profile.id)
            throw rerankError('RERANK_PROFILE_CHANGED');
        await lockOrganization(db, run.organizationId);
        const row = await db.rerankRequest.findFirst({
            where: {
                id: run.id,
                organizationId: run.organizationId,
                collectionId: run.collectionId,
                principalId: run.principalId,
                configurationId: run.profile.id,
            },
        });
        if (!row || row.state !== 'ADMITTED' || row.expiresAt <= new Date())
            throw rerankError('RERANK_REQUEST_REPLAY');
        const dispatchedAt = new Date();
        const day = utcDay(dispatchedAt);
        const total = await db.rerankUsageDay.aggregate({
            where: { organizationId: run.organizationId, day },
            _sum: { dispatchedRequests: true, dispatchedPreparedBytes: true },
        });
        const limits = rerankLimits();
        if (
            (total._sum.dispatchedRequests ?? 0n) >=
                BigInt(limits.requestsPerDay) ||
            (total._sum.dispatchedPreparedBytes ?? 0n) +
                BigInt(input.preparedInputBytes) >
                BigInt(limits.preparedBytesPerDay)
        )
            throw rerankError('RERANK_DAILY_LIMIT');
        const debit = {
            dispatchedRequests: 1n,
            dispatchedPreparedBytes: BigInt(input.preparedInputBytes),
            unknownProviderInputTokenRequests: 1n,
            unknownBilledInputTokenRequests: 1n,
            unknownBilledSearchUnitRequests: 1n,
        };
        await db.rerankUsageDay.upsert({
            where: {
                ['organizationId_day_provider']: {
                    organizationId: run.organizationId,
                    day,
                    provider: run.profile.provider,
                },
            },
            create: {
                organizationId: run.organizationId,
                day,
                provider: run.profile.provider,
                ...debit,
            },
            update: Object.fromEntries(
                Object.entries(debit).map(([key, value]) => [
                    key,
                    { increment: value },
                ])
            ),
        });
        await db.rerankRequest.update({
            where: { id: row.id },
            data: {
                state: 'DISPATCHED',
                dispatchedAt,
                dispatchDay: day,
                candidateCount: input.candidateCount,
                preparedInputBytes: BigInt(input.preparedInputBytes),
            },
        });
    });
}

/** Final checks cannot refund work already performed and never upgrade the captured generation. */
export async function recheckRerankAuthority(
    context: AuthorizedContext,
    run: RerankRun
) {
    const { actor, profile } = await rerankAuthority(
        context,
        run.collectionId,
        run.profile.revision
    );
    if (
        actor.organizationId !== run.organizationId ||
        (actor.keyId ? `key:${actor.keyId}` : `user:${actor.userId}`) !==
            run.principalId ||
        profile.id !== run.profile.id
    )
        throw rerankError('ACCESS_REVOKED');
}
