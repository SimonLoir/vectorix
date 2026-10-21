import { ORPCError } from '@orpc/server';
import { resolveVectorixFeatures } from '@routers/utils/vectorix-features';
import { superAdminV1 } from './v1-implementer';

export const getOrganizationEntitlements =
    superAdminV1.organizations.features.handler(
        async ({ context: { db }, input }) => {
            const exists = await db.organization.count({
                where: { id: input.organizationId },
            });
            if (!exists) {
                throw new ORPCError('NOT_FOUND', {
                    message: 'Organization not found',
                });
            }

            return resolveVectorixFeatures(db, input.organizationId, {
                includeInactive: true,
            });
        }
    );
