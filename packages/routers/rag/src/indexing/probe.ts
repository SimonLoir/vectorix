import { ragV1 } from '../v1-implementer';
import { probeEmbeddingModel } from '../services/indexing/models';
export const probeIndexHandler = ragV1.indexing.probe.handler(
    ({ context, input }) => probeEmbeddingModel(context, input)
);
