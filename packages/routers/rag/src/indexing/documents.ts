import { ragV1 } from '../v1-implementer';
import { listIndexDocuments } from '../services/indexing/views';
export const documentsIndexHandler = ragV1.indexing.documents.handler(
    ({ context, input }) => listIndexDocuments(context, input)
);
