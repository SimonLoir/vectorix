import { ragV1 } from '../v1-implementer';
import { discardIndex } from '../services/indexing/discard';
export const discardIndexHandler = ragV1.indexing.discard.handler(
    ({ context, input }) => discardIndex(context, input)
);
