import { ORPCError } from '@orpc/server';
import {
    isSerializationConflict,
    runSerializableTransaction,
} from '@routers/utils/transactions';
import {
    isLegacyFeatureGrantEnabled,
    readLegacyFeatureSelection,
} from '@routers/utils/vectorix-features';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';

/** Replaces a captured legacy selection, including explicit revocations, with one atomic audit. */
export const setOrganizationLegacyFeatures =
    superAdminV1.organizations.setLegacyFeatures.handler(
        ({ context: { db, headers, user }, input }) =>
            runSerializableTransaction(db, async (tx) => {
                const actor = await tx.user.findUnique({
                    where: { id: user.id },
                    select: { isSuperAdmin: true },
                });
                if (!actor?.isSuperAdmin) throw new ORPCError('FORBIDDEN');
                const before = await readLegacyFeatureSelection(
                    tx,
                    input.organizationId
                );
                if (
                    !before.organization.vectorixLegacyAccess ||
                    before.version !== input.expectedVersion
                )
                    throw new ORPCError('CONFLICT', {
                        message:
                            'Le mode legacy, le catalogue ou la sélection a changé. Rechargez avant de continuer.',
                    });
                const known = new Set(
                    before.definitions.map((feature) => feature.id)
                );
                if (input.enabledFeatureIds.some((id) => !known.has(id)))
                    throw new ORPCError('BAD_REQUEST', {
                        message:
                            'Une fonctionnalité sélectionnée ne figure plus au catalogue.',
                    });
                const selected = new Set(input.enabledFeatureIds);
                await tx.vectorixOrganizationFeatureOverride.updateMany({
                    where: {
                        organizationId: input.organizationId,
                        featureId: { notIn: [...selected] },
                    },
                    data: { enabled: false },
                });
                for (const featureId of selected) {
                    await tx.vectorixOrganizationFeatureOverride.upsert({
                        where: {
                            ['organizationId_featureId']: {
                                organizationId: input.organizationId,
                                featureId,
                            },
                        },
                        create: {
                            organizationId: input.organizationId,
                            featureId,
                            enabled: true,
                            expiresAt: null,
                        },
                        update: { enabled: true, expiresAt: null },
                    });
                }
                const after = await readLegacyFeatureSelection(
                    tx,
                    input.organizationId
                );
                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: user.id,
                    action: 'organization.legacyFeatures.set',
                    targetId: input.organizationId,
                    details: {
                        before: {
                            enabledFeatureIds: before.overrides
                                .filter((grant) =>
                                    isLegacyFeatureGrantEnabled(
                                        grant,
                                        Date.now()
                                    )
                                )
                                .map((grant) => grant.featureId)
                                .toSorted(),
                        },
                        after: { enabledFeatureIds: [...selected].toSorted() },
                    },
                });
                return {
                    organizationId: input.organizationId,
                    version: after.version,
                    enabledFeatureIds: [...selected].toSorted(),
                };
            }).catch((error: unknown) => {
                if (isSerializationConflict(error))
                    throw new ORPCError('CONFLICT', {
                        message:
                            'Un changement concurrent a eu lieu. Rechargez avant de continuer.',
                    });
                throw error;
            })
    );
