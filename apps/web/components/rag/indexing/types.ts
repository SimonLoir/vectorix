import type { RagOutputs } from '../types';
export type IndexStatus = RagOutputs['indexing']['status'];
export type IndexDocument =
    RagOutputs['indexing']['documents']['items'][number];
export type SearchResult = RagOutputs['indexing']['search']['results'][number];
export type SearchResponse = RagOutputs['indexing']['search'];
export type IndexChunk = RagOutputs['indexing']['chunks']['items'][number];
export type MetadataFields = Record<
    string,
    'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE'
>;
