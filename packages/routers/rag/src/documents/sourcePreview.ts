import { ragV1 } from '../v1-implementer';
import { previewDocumentSource } from '../services/documents/read';
export const sourcePreviewDocumentHandler =
    ragV1.documents.sourcePreview.handler(({ context, input }) =>
        previewDocumentSource(context, input)
    );
