import { retrievalV1 } from './implementer';
import { resolveRetrievalCitation } from '../services/retrieval/citation';
export const citationRetrievalHandler = retrievalV1.citation.handler(
    ({ context, input }) => resolveRetrievalCitation(context, input)
);
