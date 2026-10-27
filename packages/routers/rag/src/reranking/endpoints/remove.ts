import { ragV1 } from '../../v1-implementer';
import { removeRerankEndpoint } from '../../services/reranking/endpoints';
export const removeRerankEndpointHandler =
    ragV1.reranking.endpoints.remove.handler(({ context, input }) =>
        removeRerankEndpoint(context, input)
    );
