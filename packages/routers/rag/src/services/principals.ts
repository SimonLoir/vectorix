import type { Prisma } from '@repo/db';

/** Bounded principal names for authorized grant/group editors; never returns emails or other tenants. */
export async function principalCandidates(
    db: Prisma.TransactionClient,
    organizationId: string,
    input: {
        type: 'member' | 'group';
        query: string;
        offset: number;
        limit: number;
    }
) {
    const name = { contains: input.query, mode: 'insensitive' as const };
    if (input.type === 'group') {
        const where = { organizationId, name };
        const [items, total] = await Promise.all([
            db.organizationGroup.findMany({
                where,
                select: { id: true, name: true },
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip: input.offset,
                take: input.limit,
            }),
            db.organizationGroup.count({ where }),
        ]);
        return { items, total };
    }
    const where = { organizationId, user: { name } };
    const [members, total] = await Promise.all([
        db.member.findMany({
            where,
            select: { id: true, user: { select: { name: true } } },
            orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
            skip: input.offset,
            take: input.limit,
        }),
        db.member.count({ where }),
    ]);
    return {
        items: members.map((member) => ({
            id: member.id,
            name: member.user.name,
        })),
        total,
    };
}
