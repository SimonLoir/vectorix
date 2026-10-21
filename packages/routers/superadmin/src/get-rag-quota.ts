import { ORPCError } from '@orpc/server';
import { quotaLimits } from '@routers/rag/quotas';
import { superAdminV1 } from './v1-implementer';

/** Read effective defaults before editing, without granting platform admins collection content access. */
export const getRagQuota = superAdminV1.organizations.getRagQuota.handler(
    async ({ context, input }) => {
        const organization = await context.db.organization.findUnique({
            where: { id: input.organizationId },
            select: { id: true },
        });
        if (!organization) throw new ORPCError('NOT_FOUND');
        const [limits, override] = await Promise.all([
            quotaLimits(context.db, organization.id),
            context.db.organizationQuota.findUnique({
                where: { organizationId: organization.id },
                select: { organizationId: true },
            }),
        ]);
        return { limits, overridden: Boolean(override) };
    }
);
