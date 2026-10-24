import { resolveListWindow } from '@repo/api-contracts/v1/list-window';
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
/** Server-side window over current members; name/email search is case-insensitive. */
export const getMembers = adminMembersV1.get.handler(
    async ({ context: { db, organizationId }, input }) => {
        const window = resolveListWindow(input);
        const query = input.query?.trim();
        const where = {
            organizationId,
            ...(query
                ? {
                      user: {
                          OR: [
                              {
                                  name: {
                                      contains: query,
                                      mode: 'insensitive' as const,
                                  },
                              },
                              {
                                  email: {
                                      contains: query,
                                      mode: 'insensitive' as const,
                                  },
                              },
                          ],
                      },
                  }
                : {}),
        };
        const [members, total] = await db.$transaction([
            db.member.findMany({
                where,
                select: memberSelect,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                skip: window.offset,
                take: window.limit,
            }),
            db.member.count({ where }),
        ]);
        return { members, total };
    }
);
