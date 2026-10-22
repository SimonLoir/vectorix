import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { superAdminV1 } from './v1-implementer';
import { auditSuperAdminAction } from './audit';
import { quotaLimits } from '@routers/rag/quotas';

/** Quotas are platform policy; organization members cannot increase their own allowances. */
export const setRagQuota = superAdminV1.organizations.setRagQuota.handler(
    ({ context, input }) =>
        runSerializableTransaction(context.db, async (db) => {
            if (
                !(await db.organization.findUnique({
                    where: { id: input.organizationId },
                    select: { id: true },
                }))
            )
                throw new ORPCError('NOT_FOUND');
            const current = await quotaLimits(db, input.organizationId);
            const effective = {
                ...input.limits,
                temporaryChunksPerCollection:
                    input.limits.temporaryChunksPerCollection ??
                    current.temporaryChunksPerCollection,
            };
            const limits = {
                ...effective,
                originalBytes: BigInt(input.limits.originalBytes),
                storageBytes: BigInt(input.limits.storageBytes),
            };
            await db.organizationQuota.upsert({
                where: { organizationId: input.organizationId },
                create: { organizationId: input.organizationId, ...limits },
                update: limits,
            });
            await auditSuperAdminAction({
                db,
                headers: context.headers,
                userId: context.user.id,
                action: 'organization.ragQuota.update',
                targetId: input.organizationId,
                details: effective,
            });
            await db.ragAuditLog.create({
                data: {
                    organizationId: input.organizationId,
                    actorType: 'user',
                    actorId: context.user.id,
                    action: 'quota.update',
                    targetId: input.organizationId,
                    details: effective,
                },
            });
            return effective;
        })
);
