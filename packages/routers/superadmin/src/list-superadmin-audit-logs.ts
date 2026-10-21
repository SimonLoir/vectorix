import type { Prisma } from '@repo/db';
import { superAdminV1 } from './v1-implementer';

/** Converts legacy scalar audit payloads to the stable object-shaped V1 DTO. */
function normalizeDetails(
    details: Prisma.JsonValue | null
): Record<string, unknown> | null {
    if (details === null) return null;
    if (typeof details === 'object' && !Array.isArray(details)) return details;
    return { value: details };
}

export const listSuperAdminAuditLogs = superAdminV1.audit.list.handler(
    async ({ context: { db }, input }) => {
        const search = input.search?.trim();
        const where = {
            ...(input.action ? { action: input.action } : {}),
            ...(search
                ? {
                      OR: [
                          {
                              action: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              targetId: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              ipAddress: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              user: {
                                  is: {
                                      OR: [
                                          {
                                              name: {
                                                  contains: search,
                                                  mode: 'insensitive' as const,
                                              },
                                          },
                                          {
                                              email: {
                                                  contains: search,
                                                  mode: 'insensitive' as const,
                                              },
                                          },
                                      ],
                                  },
                              },
                          },
                      ],
                  }
                : {}),
        } satisfies Prisma.SuperAdminAuditLogWhereInput;

        const [logs, total, actionRows] = await Promise.all([
            db.superAdminAuditLog.findMany({
                where,
                select: {
                    id: true,
                    action: true,
                    targetId: true,
                    details: true,
                    ipAddress: true,
                    createdAt: true,
                    user: {
                        select: { id: true, name: true, email: true },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip: (input.page - 1) * input.limit,
                take: input.limit,
            }),
            db.superAdminAuditLog.count({ where }),
            db.superAdminAuditLog.findMany({
                distinct: ['action'],
                select: { action: true },
                orderBy: { action: 'asc' },
            }),
        ]);

        const targetIds = logs.flatMap((log) =>
            log.targetId ? [log.targetId] : []
        );
        const organizations = await db.organization.findMany({
            where: { id: { in: targetIds } },
            select: { id: true, name: true, slug: true },
        });
        const organizationsById = new Map(
            organizations.map((organization) => [organization.id, organization])
        );

        return {
            logs: logs.map((log) => ({
                ...log,
                details: normalizeDetails(log.details),
                organization: log.targetId
                    ? (organizationsById.get(log.targetId) ?? null)
                    : null,
            })),
            total,
            actions: actionRows.map((row) => row.action),
        };
    }
);
