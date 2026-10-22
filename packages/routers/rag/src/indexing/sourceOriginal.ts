import { ragV1 } from '../v1-implementer';
import { downloadIndexedOriginal } from '../services/indexing/sources';
export const sourceOriginalIndexHandler = ragV1.indexing.sourceOriginal.handler(
    ({ context, input }) => downloadIndexedOriginal(context, input)
);
