import { ragV1 } from '../v1-implementer';
import { listIndexTrash } from '../services/indexing/views';
export const trashIndexHandler = ragV1.indexing.trash.handler(
    ({ context, input }) => listIndexTrash(context, input)
);
