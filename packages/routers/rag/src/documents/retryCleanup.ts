import { ragV1 } from '../v1-implementer';
import { retryDocumentCleanup } from '../services/documents/lifecycle';
export const retryCleanupDocumentHandler = ragV1.documents.retryCleanup.handler(
    ({ context, input }) => retryDocumentCleanup(context, input)
);
