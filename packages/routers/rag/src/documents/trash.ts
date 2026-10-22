import { ragV1 } from '../v1-implementer';
import { listDeletedDocuments } from '../services/documents/lifecycle';
export const trashDocumentHandler = ragV1.documents.trash.handler(
    ({ context, input }) => listDeletedDocuments(context, input)
);
