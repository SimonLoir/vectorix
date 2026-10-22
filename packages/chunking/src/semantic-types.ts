import type { StructureOptions } from './types';

export const SEMANTIC_CHUNKER_VERSION = 'semantic-utf8-v1';
export const SEMANTIC_UNITIZER_VERSION = 'semantic-units-utf8-v1';
export const MAX_SEMANTIC_UNITS = 8192;
export const MAX_SEMANTIC_DISTANCE = 2_000_000;

export interface SemanticRange {
    ordinal: number;
    start: number;
    end: number;
}
export type SemanticUnit = SemanticRange;
export interface SemanticUnitOptions {
    maxEmbeddingInputBytes: number;
    maxUnits?: number;
}
export interface SemanticOptions extends StructureOptions {
    semanticPercentile: number;
}
export interface SemanticState {
    units: readonly SemanticUnit[];
    distances: readonly number[];
    unitManifestHash: string;
}

/** Corrupt checkpoints or invalid vectors are state failures, never provider diagnostics. */
export class SemanticStateError extends Error {
    readonly code = 'INVALID_SEMANTIC_STATE';
    constructor() {
        super('INVALID_SEMANTIC_STATE');
    }
}

/** Check persisted algorithm identities before obtaining source objects or embeddings. */
export function assertSemanticVersions(
    chunkerVersion: string,
    unitizerVersion: string
) {
    if (
        chunkerVersion !== SEMANTIC_CHUNKER_VERSION ||
        unitizerVersion !== SEMANTIC_UNITIZER_VERSION
    )
        throw new SemanticStateError();
}
