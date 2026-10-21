import { runSerializableTransaction } from '@routers/utils/transactions';
import { isCommercialFeature } from '@routers/utils/vectorix-features';
import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';

export const setOrganizationFeatureOverride =
    superAdminV1.organizations.setFeatureOverride.handler(
        ({ context: { db, headers, user }, input }) =>
            runSerializableTransaction(db, async (tx) => {
                const actor = await tx.user.findUnique({
                    where: { id: user.id },
                    select: { isSuperAdmin: true },
                });
                if (!actor?.isSuperAdmin) throw new ORPCError('FORBIDDEN');
                const [organization, feature] = await Promise.all([
                    tx.organization.findUnique({
                        where: { id: input.organizationId },
                        select: { id: true },
                    }),
                    tx.vectorixFeatureDefinition.findUnique({
                        where: { id: input.featureId },
                        select: { id: true, key: true },
                    }),
                ]);
                if (!organization) {
                    throw new ORPCError('NOT_FOUND', {
                        message: 'Organization not found',
                    });
                }
                if (!feature) {
                    throw new ORPCError('NOT_FOUND', {
                        message: 'Feature definition not found',
                    });
                }

                if (!isCommercialFeature(feature.key))
                    throw new ORPCError('BAD_REQUEST', {
                        message:
                            'Cette clé réservée ou retirée ne peut pas être attribuée comme fonctionnalité commerciale.',
                    });
                const override =
                    await tx.vectorixOrganizationFeatureOverride.upsert({
                        where: {
                            ['organizationId_featureId']: {
                                organizationId: input.organizationId,
                                featureId: input.featureId,
                            },
                        },
                        create: {
                            organizationId: input.organizationId,
                            featureId: input.featureId,
                            enabled: input.enabled,
                            reason: input.reason ?? null,
                            expiresAt: input.expiresAt ?? null,
                        },
                        update: {
                            enabled: input.enabled,
                            reason: input.reason ?? null,
                            expiresAt: input.expiresAt ?? null,
                        },
                    });

                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: user.id,
                    action: 'organization.feature_override.set',
                    targetId: input.organizationId,
                    details: {
                        featureId: feature.id,
                        featureKey: feature.key,
                        enabled: override.enabled,
                        reason: override.reason,
                        expiresAt: override.expiresAt?.toISOString() ?? null,
                    },
                });

                return override;
            })
    );
