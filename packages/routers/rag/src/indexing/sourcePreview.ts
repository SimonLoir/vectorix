import { ragV1 } from '../v1-implementer';
import { previewIndexedSource } from '../services/indexing/sources';
export const sourcePreviewIndexHandler = ragV1.indexing.sourcePreview.handler(
    ({ context, input }) => previewIndexedSource(context, input)
);
