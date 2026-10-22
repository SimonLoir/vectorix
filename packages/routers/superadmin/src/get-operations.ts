import { ORPCError } from '@orpc/server';
import { getOperationsSummary } from '@routers/rag/operations';
import { superAdminV1 } from './v1-implementer';

/** Aggregate technical work never grants an administrator access to organization content. */
export const getOperations = superAdminV1.organizations.getOperations.handler(
    async ({ context, input }) => {
        const organization = await context.db.organization.findUnique({
            where: { id: input.organizationId },
            select: { id: true },
        });
        if (!organization) throw new ORPCError('NOT_FOUND');
        return await getOperationsSummary(context.db, organization.id);
    }
);
