import { ragV1 } from '../v1-implementer';
import { configureRerankProfile } from '../services/reranking/profile';
export const configureRerankingHandler = ragV1.reranking.configure.handler(
    ({ context, input }) => configureRerankProfile(context, input)
);
