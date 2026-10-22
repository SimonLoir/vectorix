import { ragV1 } from '../v1-implementer';
import { deleteDocument } from '../services/documents/delete';
export const deleteDocumentHandler = ragV1.documents.delete.handler(
    ({ context, input }) => deleteDocument(context, input)
);
