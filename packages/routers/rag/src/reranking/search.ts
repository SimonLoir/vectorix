import { ragV1 } from '../v1-implementer';
import { searchWithReranking } from '../services/reranking/search';
export const searchRerankingHandler = ragV1.reranking.search.handler(
    ({ context, input }) => searchWithReranking(context, input)
);
