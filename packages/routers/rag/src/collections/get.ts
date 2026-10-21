import { ragV1 } from '../v1-implementer';
import { ragActor, requireCollection } from '../services/access';
import { collectionDto } from '../services/collection-view';
export const getCollection = ragV1.collections.get.handler(
    async ({ context, input }) => {
        const actor = await ragActor(context, context.db, {});
        return collectionDto(
            context.db,
            actor,
            await requireCollection(context.db, actor, input.id, 'metadata')
        );
    }
);
