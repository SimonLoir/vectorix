import { ragV1 } from '../v1-implementer';
import { getDocumentDetails } from '../services/documents/read';
export const detailsDocumentHandler = ragV1.documents.details.handler(
    ({ context, input }) => getDocumentDetails(context, input.id)
);
