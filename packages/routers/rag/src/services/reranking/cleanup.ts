import type { PrismaClient } from '@repo/db';

/** Bounded worker maintenance. Expired dispatches remain uncertain, retain debit, and are never retried automatically. */
export async function processRerankCleanup(db: PrismaClient, now = new Date()) {
    const expired = await db.rerankRequest.findMany({
        where: {
            state: { in: ['ADMITTED', 'DISPATCHED'] },
            expiresAt: { lte: now },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: 100,
        select: { id: true, state: true },
    });
    for (const row of expired)
        await db.rerankRequest.updateMany({
            where: { id: row.id, state: row.state },
            data: {
                state: row.state === 'ADMITTED' ? 'FAILED' : 'UNCERTAIN',
                completedAt: now,
                capacityReleasedAt: now,
                errorCode: 'PROVIDER_TIMEOUT',
            },
        });
    const old = await db.rerankRequest.findMany({
        where: {
            expiresAt: { lt: new Date(now.getTime() - 7 * 86_400_000) },
            capacityReleasedAt: { not: null },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: 100,
        select: { id: true },
    });
    if (old.length)
        await db.rerankRequest.deleteMany({
            where: {
                id: { in: old.map((row) => row.id) },
                capacityReleasedAt: { not: null },
            },
        });
    const oldDays = await db.rerankUsageDay.findMany({
        where: { day: { lt: new Date(now.getTime() - 30 * 86_400_000) } },
        orderBy: { day: 'asc' },
        take: 100,
        select: { organizationId: true, day: true, provider: true },
    });
    if (oldDays.length)
        await db.rerankUsageDay.deleteMany({ where: { OR: oldDays } });
    return {
        expired: expired.length,
        purged: old.length,
        daysPurged: oldDays.length,
    };
}
