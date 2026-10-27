import { ragV1 } from '../../v1-implementer';
import { activateRerankEndpoint } from '../../services/reranking/endpoints';
export const activateRerankEndpointHandler =
    ragV1.reranking.endpoints.activate.handler(({ context, input }) =>
        activateRerankEndpoint(context, input)
    );
