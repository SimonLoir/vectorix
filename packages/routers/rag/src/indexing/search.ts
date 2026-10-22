import { ragV1 } from '../v1-implementer';
import { searchCollection } from '../services/indexing/search';
export const searchIndexHandler = ragV1.indexing.search.handler(
    ({ context, input }) => searchCollection(context, input)
);
