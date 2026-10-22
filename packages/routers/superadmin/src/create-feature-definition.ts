import { ORPCError } from '@orpc/server';
import { isCommercialFeature } from '@routers/utils/vectorix-features';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const createFeatureDefinition = superAdminV1.features.create.handler(
    ({ context: { db, headers, user }, input }) =>
        runSuperAdminTransaction(db, user.id, async (tx) => {
            if (
                !isCommercialFeature(input.key) ||
                (input.externalKey !== undefined &&
                    input.externalKey !== null &&
                    !isCommercialFeature(input.externalKey))
            )
                throw new ORPCError('BAD_REQUEST', {
                    message:
                        'Une clé réservée ou retirée ne peut pas définir une fonctionnalité commerciale.',
                });
            const feature = await tx.vectorixFeatureDefinition.create({
                data: {
                    key: input.key,
                    name: input.name,
                    description: input.description ?? null,
                    category: input.category,
                    defaultEnabled: input.defaultEnabled,
                    isPaywalled: input.isPaywalled,
                    isActive: input.isActive,
                    externalKey: input.externalKey ?? null,
                },
            });

            await auditSuperAdminAction({
                db: tx,
                headers,
                userId: user.id,
                action: 'feature.create',
                targetId: feature.id,
                details: { key: feature.key, name: feature.name },
            });

            return feature;
        })
);
