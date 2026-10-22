import { ragV1 } from '../v1-implementer';
import { listEmbeddingModels } from '../services/indexing/models';
export const modelsIndexHandler = ragV1.indexing.models.handler(
    ({ context, input }) => listEmbeddingModels(context, input.collectionId)
);
