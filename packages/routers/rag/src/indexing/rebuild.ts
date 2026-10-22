import { ragV1 } from '../v1-implementer';
import { rebuildIndex } from '../services/indexing/rebuild';
export const rebuildIndexHandler = ragV1.indexing.rebuild.handler(
    ({ context, input }) => rebuildIndex(context, input)
);
