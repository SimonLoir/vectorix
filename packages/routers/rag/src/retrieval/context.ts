import { retrievalV1 } from './implementer';
import { expandRetrievalContext } from '../services/retrieval/context';
export const contextRetrievalHandler = retrievalV1.context.handler(
    ({ context, input }) => expandRetrievalContext(context, input)
);
