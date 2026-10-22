import { ragV1 } from '../v1-implementer';
import { adoptSynchronization } from '../services/indexing/synchronization';

export const adoptSynchronizationHandler =
    ragV1.indexing.adoptSynchronization.handler(({ context, input }) =>
        adoptSynchronization(context, input)
    );
