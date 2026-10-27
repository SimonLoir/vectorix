import { ragV1 } from '../../v1-implementer';
import { extendedRerankUsage } from '../../services/reranking/usage';
export const usageExtendedRerankingHandler =
    ragV1.reranking.extended.usage.handler(({ context }) =>
        extendedRerankUsage(context)
    );
