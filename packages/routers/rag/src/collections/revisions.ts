import { configurationDto } from '../services/collection-view';
import { ragV1 } from '../v1-implementer';
import { ragActor, requireCollection } from '../services/access';

/** History is catalog metadata, scoped like the current profile; the DTO strips endpoints and secrets. */
export const listRevisions = ragV1.collections.revisions.handler(
    async ({ context, input }) => {
        const actor = await ragActor(context, context.db, {});
        await requireCollection(context.db, actor, input.id, 'metadata');
        const where = {
            organizationId: actor.organizationId,
            collectionId: input.id,
            model: { contains: input.query, mode: 'insensitive' as const },
        };
        const [items, total] = await Promise.all([
            context.db.collectionConfigRevision.findMany({
                where,
                orderBy: { revision: 'desc' },
                skip: input.offset,
                take: input.limit,
            }),
            context.db.collectionConfigRevision.count({ where }),
        ]);
        return {
            items: items.map((item) => ({
                revision: item.revision,
                createdAt: item.createdAt,
                configuration: configurationDto(item),
            })),
            total,
        };
    }
);
