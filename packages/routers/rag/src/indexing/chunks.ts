import { ragV1 } from '../v1-implementer';
import { listIndexChunks } from '../services/indexing/views';
export const chunksIndexHandler = ragV1.indexing.chunks.handler(
    ({ context, input }) => listIndexChunks(context, input)
);
