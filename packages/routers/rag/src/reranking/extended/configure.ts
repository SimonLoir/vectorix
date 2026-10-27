import { ragV1 } from '../../v1-implementer';
import { configureExtendedRerankProfile } from '../../services/reranking/profile';
export const configureExtendedRerankingHandler =
    ragV1.reranking.extended.configure.handler(({ context, input }) =>
        configureExtendedRerankProfile(context, input)
    );
