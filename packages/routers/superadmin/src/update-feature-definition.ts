import { isCommercialFeature } from '@routers/utils/vectorix-features';
import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const updateFeatureDefinition = superAdminV1.features.update.handler(
    ({ context: { db, headers, user }, input }) =>
        runSuperAdminTransaction(db, user.id, async (tx) => {
            const existing = await tx.vectorixFeatureDefinition.findUnique({
                where: { id: input.featureId },
            });
            if (!existing) {
                throw new ORPCError('NOT_FOUND', {
                    message: 'Feature definition not found',
                });
            }

            if (
                !isCommercialFeature(existing.key) ||
                (input.key !== undefined && !isCommercialFeature(input.key)) ||
                (input.externalKey !== undefined &&
                    input.externalKey !== null &&
                    !isCommercialFeature(input.externalKey))
            )
                throw new ORPCError('BAD_REQUEST', {
                    message:
                        'Une clé réservée ou retirée ne peut pas définir une fonctionnalité commerciale.',
                });
            const data: Prisma.VectorixFeatureDefinitionUpdateInput = {};
            if (input.key !== undefined) data.key = input.key;
            if (input.name !== undefined) data.name = input.name;
            if (input.description !== undefined)
                data.description = input.description;
            if (input.category !== undefined) data.category = input.category;
            if (input.defaultEnabled !== undefined)
                data.defaultEnabled = input.defaultEnabled;
            if (input.isPaywalled !== undefined)
                data.isPaywalled = input.isPaywalled;
            if (input.isActive !== undefined) data.isActive = input.isActive;
            if (input.externalKey !== undefined)
                data.externalKey = input.externalKey;

            const feature = await tx.vectorixFeatureDefinition.update({
                where: { id: input.featureId },
                data,
            });

            await auditSuperAdminAction({
                db: tx,
                headers,
                userId: user.id,
                action: 'feature.update',
                targetId: feature.id,
                details: {
                    key: feature.key,
                    defaultEnabled: feature.defaultEnabled,
                    isPaywalled: feature.isPaywalled,
                    isActive: feature.isActive,
                },
            });

            return feature;
        })
);
