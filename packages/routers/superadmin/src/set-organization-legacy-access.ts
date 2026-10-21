import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';

/** Atomically records an explicit entitlement exemption and its audit trail; never touches a provider or financial record. */
export const setOrganizationLegacyAccess =
    superAdminV1.organizations.setLegacyAccess.handler(
        ({ context: { db, headers, user }, input }) =>
            runSerializableTransaction(db, async (tx) => {
                const existing = await tx.organization.findUnique({
                    where: { id: input.organizationId },
                    select: { id: true, vectorixLegacyAccess: true },
                });
                if (!existing) throw new ORPCError('NOT_FOUND');
                const organization = await tx.organization.update({
                    where: { id: existing.id },
                    data: { vectorixLegacyAccess: input.enabled },
                    select: { id: true, vectorixLegacyAccess: true },
                });
                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: user.id,
                    action: 'organization.setLegacyAccess',
                    targetId: existing.id,
                    details: {
                        before: {
                            vectorixLegacyAccess: existing.vectorixLegacyAccess,
                        },
                        after: {
                            vectorixLegacyAccess:
                                organization.vectorixLegacyAccess,
                        },
                    },
                });
                return organization;
            })
    );
