import { ragV1 } from '../v1-implementer';
import { startIndex } from '../services/indexing/start';
export const startIndexHandler = ragV1.indexing.start.handler(
    ({ context, input }) => startIndex(context, input)
);
