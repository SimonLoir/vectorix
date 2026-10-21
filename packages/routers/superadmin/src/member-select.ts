import type { Prisma } from '@repo/db';

/** Keeps super-admin member mutation responses aligned with the frozen V1 DTO. */
export const organizationMemberSelect = {
    id: true,
    role: true,
    createdAt: true,
    user: {
        select: {
            id: true,
            name: true,
            email: true,
            image: true,
            emailVerified: true,
        },
    },
} satisfies Prisma.MemberSelect;
