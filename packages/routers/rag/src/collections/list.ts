import { ragV1 } from '../v1-implementer';
import { ragActor, collectionMetadataWhere } from '../services/access';
import { collectionDto } from '../services/collection-view';
export const listCollections = ragV1.collections.list.handler(
    async ({ context, input }) => {
        const actor = await ragActor(context, context.db, {});
        const where = {
            AND: [
                collectionMetadataWhere(actor),
                {
                    name: {
                        contains: input.query,
                        mode: 'insensitive' as const,
                    },
                },
            ],
        };
        const [items, total] = await Promise.all([
            context.db.collection.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: input.offset,
                take: input.limit,
            }),
            context.db.collection.count({ where }),
        ]);
        return {
            items: await Promise.all(
                items.map((item) => collectionDto(context.db, actor, item))
            ),
            total,
        };
    }
);
