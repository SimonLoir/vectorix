import type {
    operationCategory,
    operationItem,
    operationsInput,
    operationState,
} from '@repo/api-contracts/v1/rag/operations';

export type OperationsInput = typeof operationsInput._output;
export type OperationCategory = typeof operationCategory._output;
export type OperationState = typeof operationState._output;
export type OperationRow = Omit<typeof operationItem._output, 'target'> & {
    targetId: string;
    deleted: boolean;
};

export const categories = [
    'INGESTION',
    'DOCUMENT_CLEANUP',
    'INDEXING',
] as const satisfies readonly OperationCategory[];
