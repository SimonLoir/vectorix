import { ragV1 } from '../v1-implementer';
import { setDocumentCollection } from '../services/documents/associations';
export const setCollectionDocumentHandler =
    ragV1.documents.setCollection.handler(({ context, input }) =>
        setDocumentCollection(context, input)
    );
