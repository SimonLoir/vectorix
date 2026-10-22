import type { VectorixApiV1Outputs } from '@repo/api';

export type Operations =
    VectorixApiV1Outputs['admin']['rag']['operations']['overview'];
export type OperationItem = Operations['items'][number];
export type OperationCategory = OperationItem['category'];
export type OperationFilter = 'ALL' | OperationItem['state'];
