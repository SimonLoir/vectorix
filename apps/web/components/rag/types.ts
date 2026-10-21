import type { VectorixApiV1Outputs } from '@repo/api';
export type RagOutputs = VectorixApiV1Outputs['admin']['rag'];
export type Credential = RagOutputs['credentials']['list']['items'][number];
export type Collection = RagOutputs['collections']['get'];
export type Group = RagOutputs['groups']['list']['items'][number];
export type Grant = RagOutputs['collections']['grants']['items'][number];
