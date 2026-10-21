import { ORPCError } from '@orpc/server';
import { ragV1 } from '../v1-implementer';
import { ragActor } from '../services/access';
import { principalCandidates } from '../services/principals';

export const listMemberCandidates = ragV1.groups.memberCandidates.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragGroups: ['manage'] },
            true
        );
        const group = await context.db.organizationGroup.findFirst({
            where: { id: input.id, organizationId: actor.organizationId },
            select: { id: true },
        });
        if (!group) throw new ORPCError('NOT_FOUND');
        return principalCandidates(context.db, actor.organizationId, {
            ...input,
            type: 'member',
        });
    }
);
