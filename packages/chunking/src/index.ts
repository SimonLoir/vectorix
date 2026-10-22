export { chunkDocumentStructure } from './structure';
export { chunkTokenWindow } from './token-window';
export { resolveChunkingStrategy } from './strategy';
export type { ChunkerVersion, ResolvedChunkingStrategy } from './strategy';
export {
    STRUCTURE_CHUNKER_VERSION,
    TOKEN_WINDOW_CHUNKER_VERSION,
    MAX_CHUNKS_PER_DOCUMENT,
    ChunkingError,
} from './types';
export type { StructureOptions, PlannedChunk, ChunkSpan } from './types';
