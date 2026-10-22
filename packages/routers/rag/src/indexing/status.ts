import { ragV1 } from '../v1-implementer';
import { getIndexStatus } from '../services/indexing/views';
export const statusIndexHandler = ragV1.indexing.status.handler(
    ({ context, input }) => getIndexStatus(context, input.collectionId)
);
