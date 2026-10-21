import type { Prisma } from '@repo/db';

/** Explicit account fields allowed in the global superadmin directory and access mutation response. */
export const superAdminUserSelect = {
    id: true,
    name: true,
    email: true,
    emailVerified: true,
    image: true,
    isSuperAdmin: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { members: true } },
} satisfies Prisma.UserSelect;
