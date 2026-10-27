import type { RagOutputs } from '../types';

export type RerankProfile = RagOutputs['reranking']['extended']['profile'];
export type RerankedSearchResponse =
    RagOutputs['reranking']['extended']['search'];
export type RerankProvider = NonNullable<
    RerankProfile['configuration']
>['provider'];
export type RerankEndpoint =
    RagOutputs['reranking']['endpoints']['list']['items'][number];
export type RerankRuntimeSnapshot = NonNullable<
    NonNullable<RerankProfile['configuration']>['runtimeSnapshot']
>;

export type EndpointConfirmation = Readonly<{
    item: RerankEndpoint;
    kind: 'activate' | 'remove';
}>;
