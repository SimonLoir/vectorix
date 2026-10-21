import { ORPCError } from '@orpc/server';
import { adminMembersV1 } from './v1-implementer';
import { memberSelect } from './get-members';
export const getCurrentMember = adminMembersV1.me.handler(
    async ({ context }) => {
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const member = await context.db.member.findFirst({
            where: {
                organizationId: context.organizationId,
                userId: context.user.id,
            },
            select: memberSelect,
        });
        if (!member) throw new ORPCError('UNAUTHORIZED');
        return member;
    }
);
