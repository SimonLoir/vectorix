import { ragV1 } from '../v1-implementer';
import { updateDocumentMetadata } from '../services/indexing/metadata';
export const updateMetadataIndexHandler = ragV1.indexing.updateMetadata.handler(
    ({ context, input }) => updateDocumentMetadata(context, input)
);
