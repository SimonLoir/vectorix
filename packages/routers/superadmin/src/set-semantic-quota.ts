import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { quotaLimits } from '@routers/rag/quotas';
import { semanticQuotaPersistence } from '@routers/rag/semantic-quotas';
import { superAdminV1 } from './v1-implementer';
import { requireCurrentSuperAdmin } from './superadmin-transaction';
import { auditSuperAdminAction } from './audit';

/** Save separate semantic policy atomically, preserving all legacy quota fields and current deployment defaults. */
export const setSemanticQuota =
    superAdminV1.organizations.setSemanticQuota.handler(({ context, input }) =>
        runSerializableTransaction(context.db, async (db) => {
            await requireCurrentSuperAdmin(db, context.user.id);
            if (
                !(await db.organization.findUnique({
                    where: { id: input.organizationId },
                    select: { id: true },
                }))
            )
                throw new ORPCError('NOT_FOUND');
            const legacy = await quotaLimits(db, input.organizationId);
            const limits = semanticQuotaPersistence(input.limits);
            await db.organizationQuota.upsert({
                where: { organizationId: input.organizationId },
                create: {
                    organizationId: input.organizationId,
                    ...legacy,
                    originalBytes: BigInt(legacy.originalBytes),
                    storageBytes: BigInt(legacy.storageBytes),
                    ...limits,
                },
                update: limits,
            });
            await auditSuperAdminAction({
                db,
                headers: context.headers,
                userId: context.user.id,
                action: 'organization.semanticQuota.update',
                targetId: input.organizationId,
                details: input.limits,
            });
            await db.ragAuditLog.create({
                data: {
                    organizationId: input.organizationId,
                    actorType: 'user',
                    actorId: context.user.id,
                    action: 'semanticQuota.update',
                    targetId: input.organizationId,
                    details: input.limits,
                },
            });
            return input.limits;
        })
    );
