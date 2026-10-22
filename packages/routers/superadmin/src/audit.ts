import type { Prisma, PrismaClient } from '@repo/db';

interface AuditSuperAdminActionInput {
    db: Pick<PrismaClient, 'superAdminAuditLog'>;
    headers: Headers;
    userId: string;
    action: string;
    targetId?: string;
    details?: Prisma.InputJsonValue;
}

/** Write alongside the mutation; request headers do not establish a verified network peer. */
export async function auditSuperAdminAction({
    db,
    userId,
    action,
    targetId,
    details,
}: AuditSuperAdminActionInput) {
    await db.superAdminAuditLog.create({
        data: {
            userId,
            action: `vectorix.${action}`,
            targetId: targetId ?? null,
            details,
            ipAddress: null,
        },
    });
}
