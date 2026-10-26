import { ragV1 } from '../v1-implementer';
import { getRerankProfile } from '../services/reranking/profile';
export const profileRerankingHandler = ragV1.reranking.profile.handler(
    ({ context, input }) => getRerankProfile(context, input.collectionId)
);
