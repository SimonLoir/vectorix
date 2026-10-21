import { ragV1 } from '../v1-implementer';
import { createCollection } from '../services/collections';
export const createCollectionHandler = ragV1.collections.create.handler(
    ({ context, input }) => createCollection(context, input)
);
