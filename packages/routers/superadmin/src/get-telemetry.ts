import { ORPCError } from '@orpc/server';
import { getTelemetrySummary } from '@routers/rag/telemetry-read';
import { superAdminV1 } from './v1-implementer';

/** Technical aggregates do not grant membership, content access or recovery rights. */
export const getTelemetry = superAdminV1.organizations.getTelemetry.handler(
    async ({ context, input }) => {
        const result = await getTelemetrySummary(
            context.db,
            input.organizationId,
            { window: input.window }
        );
        const current = await context.db.user.findUnique({
            where: { id: context.user.id },
            select: { isSuperAdmin: true },
        });
        if (!current?.isSuperAdmin) throw new ORPCError('FORBIDDEN');
        return result;
    }
);
