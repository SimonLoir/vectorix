import { ragV1 } from '../v1-implementer';
import { replaceDocument } from '../services/documents/replace';
export const replaceDocumentHandler = ragV1.documents.replace.handler(
    ({ context, input }) => replaceDocument(context, input)
);
