import type { Prisma, PrismaClient } from '@repo/db';

interface AuditSuperAdminActionInput {
    db: Pick<PrismaClient, 'superAdminAuditLog'>;
    headers: Headers;
    userId: string;
    action: string;
    targetId?: string;
    details?: Prisma.InputJsonValue;
}

/** Persists a trace for every Vectorix super-admin mutation. */
export async function auditSuperAdminAction({
    db,
    headers,
    userId,
    action,
    targetId,
    details,
}: AuditSuperAdminActionInput) {
    const forwardedFor = headers.get('x-forwarded-for');
    const ipAddress = forwardedFor?.split(',')[0]?.trim() ?? null;

    await db.superAdminAuditLog.create({
        data: {
            userId,
            action: `vectorix.${action}`,
            targetId: targetId ?? null,
            details,
            ipAddress,
        },
    });
}
