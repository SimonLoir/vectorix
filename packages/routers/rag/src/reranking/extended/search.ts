import { ragV1 } from '../../v1-implementer';
import { searchWithExtendedReranking } from '../../services/reranking/search';
export const searchExtendedRerankingHandler =
    ragV1.reranking.extended.search.handler(({ context, input }) =>
        searchWithExtendedReranking(context, input)
    );
