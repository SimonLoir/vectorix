import { ragV1 } from '../v1-implementer';
import { previewDocument } from '../services/documents/read';
export const previewDocumentHandler = ragV1.documents.preview.handler(
    ({ context, input }) => previewDocument(context, input)
);
