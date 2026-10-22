import { ORPCError } from '@orpc/server';
import { getWorkerObservations as readWorkerObservations } from '@routers/rag/telemetry-read';
import { superAdminV1 } from './v1-implementer';

export const getWorkerObservations = superAdminV1.getWorkerObservations.handler(
    async ({ context }) => {
        const result = await readWorkerObservations(context.db);
        const current = await context.db.user.findUnique({
            where: { id: context.user.id },
            select: { isSuperAdmin: true },
        });
        if (!current?.isSuperAdmin) throw new ORPCError('FORBIDDEN');
        return result;
    }
);
