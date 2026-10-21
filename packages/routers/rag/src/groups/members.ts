import { ORPCError } from '@orpc/server';
import { ragV1 } from '../v1-implementer';
import { ragActor } from '../services/access';
export const listGroupMembers = ragV1.groups.members.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragGroups: ['read'] },
            true
        );
        if (
            !(await context.db.organizationGroup.findFirst({
                where: { id: input.id, organizationId: actor.organizationId },
            }))
        )
            throw new ORPCError('NOT_FOUND');
        const where = {
            organizationId: actor.organizationId,
            groupId: input.id,
            member: {
                user: {
                    name: {
                        contains: input.query,
                        mode: 'insensitive' as const,
                    },
                },
            },
        };
        const [items, total] = await Promise.all([
            context.db.groupMember.findMany({
                where,
                include: {
                    member: { select: { user: { select: { name: true } } } },
                },
                orderBy: { memberId: 'asc' },
                skip: input.offset,
                take: input.limit,
            }),
            context.db.groupMember.count({ where }),
        ]);
        return {
            items: items.map((item) => ({
                memberId: item.memberId,
                name: item.member.user.name,
            })),
            total,
        };
    }
);
