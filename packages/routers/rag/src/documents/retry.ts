import { ragV1 } from '../v1-implementer';
import { retryDocument } from '../services/documents/retry';
export const retryDocumentHandler = ragV1.documents.retry.handler(
    ({ context, input }) => retryDocument(context, input.id)
);
