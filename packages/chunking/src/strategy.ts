import type { StructuredExtraction } from '@repo/documents';
import { chunkDocumentStructure } from './structure';
import { chunkTokenWindow } from './token-window';
import {
    ChunkingError,
    STRUCTURE_CHUNKER_VERSION,
    TOKEN_WINDOW_CHUNKER_VERSION,
    type PlannedChunk,
    type StructureOptions,
} from './types';

export type ChunkerVersion =
    typeof STRUCTURE_CHUNKER_VERSION | typeof TOKEN_WINDOW_CHUNKER_VERSION;
export interface ResolvedChunkingStrategy {
    version: ChunkerVersion;
    plan: (
        artifact: StructuredExtraction,
        options: StructureOptions
    ) => Generator<PlannedChunk>;
}

/**
 * Resolve admission's current version, or validate an exact saved strategy/version pair.
 * This check is synchronous and needs no source, credential or provider access; callers
 * must pass the persisted version during replay before starting any external I/O.
 */
export function resolveChunkingStrategy(
    strategy: string,
    savedVersion?: string
): ResolvedChunkingStrategy {
    const resolved: ResolvedChunkingStrategy | undefined =
        strategy === 'DOCUMENT_STRUCTURE'
            ? {
                  version: STRUCTURE_CHUNKER_VERSION,
                  plan: chunkDocumentStructure,
              }
            : strategy === 'TOKEN_WINDOW'
              ? {
                    version: TOKEN_WINDOW_CHUNKER_VERSION,
                    plan: chunkTokenWindow,
                }
              : undefined;
    if (
        !resolved ||
        (savedVersion !== undefined && savedVersion !== resolved.version)
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    return resolved;
}
