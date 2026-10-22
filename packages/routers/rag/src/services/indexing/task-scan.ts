import type { Prisma, PrismaClient } from '@repo/db';

/**
 * Resume up to five eligible semantic allowance holders before ordinary work, while
 * keeping at least five scan slots available to other eligible task classes.
 * Saved live reservations define holders even after interruptions or transient
 * failures; task stage labels do not. Claim CAS remains the authority when
 * concurrent workers observe the same bounded scan.
 */
export async function scanIndexTasks(db: PrismaClient) {
    const now = new Date();
    const eligible: Prisma.IndexTaskWhereInput = {
        availableAt: { lte: now },
        AND: [
            {
                OR: [
                    { status: 'PENDING' },
                    {
                        status: 'PROCESSING',
                        leasedUntil: { lte: now },
                    },
                ],
            },
            {
                OR: [
                    { kind: { not: 'INDEX_DOCUMENT' } },
                    {
                        generation: {
                            status: { in: ['BUILDING', 'ACTIVE'] },
                        },
                    },
                ],
            },
        ],
    };
    const semanticHolder: Prisma.IndexTaskWhereInput = {
        kind: 'INDEX_DOCUMENT',
        indexedDocument: {
            is: {
                semanticPlan: {
                    is: {
                        state: { in: ['PLANNING', 'READY'] },
                        OR: [
                            { reservedBytes: { gt: 0n } },
                            { reservedPreparedBytes: { gt: 0n } },
                            { reservedBatches: { gt: 0 } },
                        ],
                    },
                },
            },
        },
    };
    const orderBy: Prisma.IndexTaskOrderByWithRelationInput[] = [
        { availableAt: 'asc' },
        { createdAt: 'asc' },
        { id: 'asc' },
    ];
    // Attribution is captured with the existing bounded scan; no telemetry-only query or mutable draft read.
    const include = {
        generation: {
            select: {
                configuration: {
                    select: { provider: true, chunkingStrategy: true },
                },
            },
        },
    } as const;
    const priority = await db.indexTask.findMany({
        where: { AND: [eligible, semanticHolder] },
        orderBy,
        take: 5,
        include,
    });
    const ordinary = await db.indexTask.findMany({
        where: { AND: [eligible, { NOT: semanticHolder }] },
        orderBy,
        take: 10 - priority.length,
        include,
    });
    return [...priority, ...ordinary];
}
