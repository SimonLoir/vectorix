import { ragV1 } from '../v1-implementer';
import { uploadDocument } from '../services/documents/upload';
export const uploadDocumentHandler = ragV1.documents.upload.handler(
    ({ context, input }) => uploadDocument(context, input)
);
