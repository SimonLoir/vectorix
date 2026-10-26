import type { CollectionRerankConfig } from '@repo/db';
import type { RerankingProvider } from '@repo/reranking/models';

export type RerankRun = {
    id: string;
    organizationId: string;
    collectionId: string;
    generationId: string;
    principalId: string;
    profile: CollectionRerankConfig & {
        provider: RerankingProvider;
        endpoint: string;
    };
};
