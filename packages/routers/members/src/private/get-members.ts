import { adminMembersV1 } from './v1-implementer';
export const memberSelect = {
    id: true,
    organizationId: true,
    userId: true,
    role: true,
    createdAt: true,
    avatarColor: true,
    user: { select: { id: true, name: true, email: true, image: true } },
} as const;
export const getMembers = adminMembersV1.get.handler(
    async ({ context: { db, organizationId } }) => ({
        members: await db.member.findMany({
            where: { organizationId },
            select: memberSelect,
        }),
    })
);
