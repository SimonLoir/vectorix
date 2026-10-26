import type { z } from 'zod';
import type { searchResult } from '@repo/api-contracts/v1/rag/indexing-types';
import type { SearchFilters } from './filters';

export type SearchInput = {
    collectionId: string;
    query: string;
    topK: number;
    strategy: 'HYBRID' | 'LEXICAL' | 'VECTOR';
    filters: SearchFilters;
};
export type SearchScores = {
    rrf: number;
    lexicalRank: number | null;
    vectorRank: number | null;
    vectorDistance: number | null;
};
export type SearchRanking = [string, SearchScores][];
export type SearchResponse = {
    generationId: string;
    model: string;
    strategy: SearchInput['strategy'];
    results: z.output<typeof searchResult>[];
    vectorUnderfilled: boolean;
    parentUnderfilled?: boolean;
    durationMs: number;
};
export type SearchChild = {
    id: string;
    indexedDocumentId: string;
    parentId: string | null;
    text: string;
};
export type SearchReranking = Readonly<{
    generationId: string;
    candidateLimit: number;
    compare: boolean;
    startedAt: number;
    rank: (
        input: Readonly<{
            candidates: readonly SearchChild[];
            assertCurrent: () => Promise<void>;
            remainingMs: () => number;
        }>
    ) => Promise<readonly { index: number; score: number }[]>;
}>;
export type SearchExecution = {
    response: SearchResponse;
    comparison?: SearchResponse;
    rerankScores: ReadonlyMap<string, number>;
    candidateCount: number;
    rerankedCount: number;
};
