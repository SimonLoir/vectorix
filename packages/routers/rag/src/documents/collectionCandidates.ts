import { ragV1 } from '../v1-implementer';
import { documentCollectionCandidates } from '../services/documents/associations';
export const collectionCandidatesDocumentHandler =
    ragV1.documents.collectionCandidates.handler(({ context, input }) =>
        documentCollectionCandidates(context, input)
    );
