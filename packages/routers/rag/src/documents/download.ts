import { ragV1 } from '../v1-implementer';
import { downloadDocument } from '../services/documents/read';
export const downloadDocumentHandler = ragV1.documents.download.handler(
    ({ context, input }) => downloadDocument(context, input.id)
);
