import { ragV1 } from '../v1-implementer';
import { listIndexTasks } from '../services/indexing/views';
export const tasksIndexHandler = ragV1.indexing.tasks.handler(
    ({ context, input }) => listIndexTasks(context, input)
);
