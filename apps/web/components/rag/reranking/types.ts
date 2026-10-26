import type { RagOutputs } from '../types';

export type RerankProfile = RagOutputs['reranking']['profile'];
export type RerankedSearchResponse = RagOutputs['reranking']['search'];
export type RerankProvider = NonNullable<
    RerankProfile['configuration']
>['provider'];
