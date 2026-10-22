import { ragV1 } from '../v1-implementer';
import { getOperationsOverview } from '../services/operations';

export const operationsOverviewHandler = ragV1.operations.overview.handler(
    ({ context, input }) => getOperationsOverview(context, input)
);
