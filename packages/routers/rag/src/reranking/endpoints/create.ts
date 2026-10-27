import { ragV1 } from '../../v1-implementer';
import { createRerankEndpoint } from '../../services/reranking/endpoints';
export const createRerankEndpointHandler =
    ragV1.reranking.endpoints.create.handler(({ context, input }) =>
        createRerankEndpoint(context, input)
    );
