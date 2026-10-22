import type { ExtractionSource } from '@repo/documents';

export const STRUCTURE_CHUNKER_VERSION = 'structure-utf8-v1';
export const TOKEN_WINDOW_CHUNKER_VERSION = 'token-window-utf8-v1';
export const MAX_CHUNKS_PER_DOCUMENT = 100_000;
/** Token counts are estimates; the independent byte cap protects the verified model context. */
export interface StructureOptions {
    targetTokens: number;
    minTokens: number;
    maxTokens: number;
    overlapTokens: number;
    maxEmbeddingInputBytes: number;
    maxChunks?: number;
}
export interface ChunkSpan {
    source: ExtractionSource;
    start: number;
    end: number;
}
export interface PlannedChunk {
    ordinal: number;
    start: number;
    end: number;
    text: string;
    heading?: string;
    tokenCount: number;
    tokenCountIsEstimate: true;
    sourceSpans: ChunkSpan[];
}
export interface StructureGroup {
    start: number;
    end: number;
    heading?: string;
    boundaries: number[];
}
export class ChunkingError extends Error {
    constructor(readonly code: 'INVALID_CHUNK_PROFILE' | 'CHUNK_LIMIT') {
        super(code);
    }
}
