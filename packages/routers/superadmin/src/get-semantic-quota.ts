import { ORPCError } from '@orpc/server';
import {
    semanticQuotaLimits,
    semanticQuotaUsage,
} from '@routers/rag/semantic-quotas';
import { superAdminV1 } from './v1-implementer';

/** Technical work visibility does not grant platform administrators collection content access. */
export const getSemanticQuota =
    superAdminV1.organizations.getSemanticQuota.handler(
        async ({ context, input }) => {
            if (
                !(await context.db.organization.findUnique({
                    where: { id: input.organizationId },
                    select: { id: true },
                }))
            )
                throw new ORPCError('NOT_FOUND');
            const [limits, usage, override] = await Promise.all([
                semanticQuotaLimits(context.db, input.organizationId),
                semanticQuotaUsage(context.db, input.organizationId),
                context.db.organizationQuota.findUnique({
                    where: { organizationId: input.organizationId },
                    select: { organizationId: true },
                }),
            ]);
            return { limits, usage, overridden: Boolean(override) };
        }
    );
