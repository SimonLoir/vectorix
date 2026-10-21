import { runSerializableTransaction } from '@routers/utils/transactions';
import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';

export const clearOrganizationFeatureOverride =
    superAdminV1.organizations.clearFeatureOverride.handler(
        ({ context: { db, headers, user }, input }) =>
            runSerializableTransaction(db, async (tx) => {
                const actor = await tx.user.findUnique({
                    where: { id: user.id },
                    select: { isSuperAdmin: true },
                });
                if (!actor?.isSuperAdmin) throw new ORPCError('FORBIDDEN');
                const existing =
                    await tx.vectorixOrganizationFeatureOverride.findUnique({
                        where: {
                            ['organizationId_featureId']: {
                                organizationId: input.organizationId,
                                featureId: input.featureId,
                            },
                        },
                        include: { feature: { select: { key: true } } },
                    });
                if (!existing) {
                    throw new ORPCError('NOT_FOUND', {
                        message: 'Feature override not found',
                    });
                }

                await tx.vectorixOrganizationFeatureOverride.delete({
                    where: { id: existing.id },
                });

                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: user.id,
                    action: 'organization.feature_override.clear',
                    targetId: input.organizationId,
                    details: {
                        featureId: input.featureId,
                        featureKey: existing.feature.key,
                    },
                });

                return { success: true };
            })
    );
