import { ragV1 } from '../../v1-implementer';
import { updateRerankEndpoint } from '../../services/reranking/endpoints';
export const updateRerankEndpointHandler =
    ragV1.reranking.endpoints.update.handler(({ context, input }) =>
        updateRerankEndpoint(context, input)
    );
