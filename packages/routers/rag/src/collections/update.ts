import { ragV1 } from '../v1-implementer';
import { updateCollection } from '../services/collections';
export const updateCollectionHandler = ragV1.collections.update.handler(
    ({ context, input }) => updateCollection(context, input)
);
