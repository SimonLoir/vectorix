import { ragV1 } from '../v1-implementer';
import { ragActor } from '../services/access';
import { credentialInclude, credentialDto } from '../services/credential-data';
export const listCredentials = ragV1.credentials.list.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragCredentials: ['read'] },
            true
        );
        const where = {
            organizationId: actor.organizationId,
            name: { contains: input.query, mode: 'insensitive' as const },
        };
        const [items, total] = await Promise.all([
            context.db.credentials.findMany({
                where,
                include: credentialInclude,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: input.offset,
                take: input.limit,
            }),
            context.db.credentials.count({ where }),
        ]);
        return { items: items.map(credentialDto), total };
    }
);
