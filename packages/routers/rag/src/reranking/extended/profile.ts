import { ragV1 } from '../../v1-implementer';
import { getExtendedRerankProfile } from '../../services/reranking/profile';
export const profileExtendedRerankingHandler =
    ragV1.reranking.extended.profile.handler(({ context, input }) =>
        getExtendedRerankProfile(context, input.collectionId)
    );
