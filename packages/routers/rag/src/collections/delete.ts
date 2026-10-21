import { ragV1 } from '../v1-implementer';
import { deleteCollection } from '../services/collections';
export const deleteCollectionHandler = ragV1.collections.delete.handler(
    ({ context, input }) => deleteCollection(context, input)
);
