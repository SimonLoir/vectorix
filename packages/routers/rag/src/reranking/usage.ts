import { ragV1 } from '../v1-implementer';
import { rerankUsage } from '../services/reranking/usage';
export const usageRerankingHandler = ragV1.reranking.usage.handler(
    ({ context }) => rerankUsage(context)
);
