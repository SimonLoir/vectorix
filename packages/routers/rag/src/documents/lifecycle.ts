import { ragV1 } from '../v1-implementer';
import { getDocumentLifecycle } from '../services/documents/lifecycle';
export const lifecycleDocumentHandler = ragV1.documents.lifecycle.handler(
    ({ context, input }) => getDocumentLifecycle(context, input)
);
