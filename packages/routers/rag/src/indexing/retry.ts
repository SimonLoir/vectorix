import { ragV1 } from '../v1-implementer';
import { retryIndexTask } from '../services/indexing/retry';
export const retryIndexHandler = ragV1.indexing.retry.handler(
    ({ context, input }) => retryIndexTask(context, input)
);
