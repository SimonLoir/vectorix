import { retrievalV1 } from './implementer';
import { searchRetrieval } from '../services/retrieval/search';
export const searchRetrievalHandler = retrievalV1.search.handler(
    ({ context, input }) => searchRetrieval(context, input)
);
