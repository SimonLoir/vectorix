import { ragV1 } from '../v1-implementer';
import { ragActor } from '../services/access';
export const listGroups = ragV1.groups.list.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragGroups: ['read'] },
            true
        );
        const where = {
            organizationId: actor.organizationId,
            name: { contains: input.query, mode: 'insensitive' as const },
        };
        const [groups, total] = await Promise.all([
            context.db.organizationGroup.findMany({
                where,
                include: { _count: { select: { members: true } } },
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip: input.offset,
                take: input.limit,
            }),
            context.db.organizationGroup.count({ where }),
        ]);
        return {
            items: groups.map((group) => ({
                ...group,
                memberCount: group._count.members,
            })),
            total,
        };
    }
);
