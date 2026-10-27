import { ragV1 } from '../../v1-implementer';
import { listRerankEndpoints } from '../../services/reranking/endpoints';
export const listRerankEndpointsHandler =
    ragV1.reranking.endpoints.list.handler(({ context, input }) =>
        listRerankEndpoints(context, input)
    );
