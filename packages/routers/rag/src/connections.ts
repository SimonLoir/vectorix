import { ragV1 } from './v1-implementer';
import { ragActor } from './services/access';
export const listConnections = ragV1.connections.handler(
    async ({ context }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragCollection: ['create'] },
            true
        );
        const items = await context.db.vectorConnection.findMany({
            where: { organizationId: actor.organizationId, key: 'platform' },
            select: { id: true, name: true },
            take: 1,
        });
        return {
            items: items.map((item) => ({
                ...item,
                kind: 'PLATFORM_POSTGRESQL' as const,
            })),
        };
    }
);
