export type IndexType = 'HNSW' | 'DISKANN';
export interface DestinationConfig {
    runtimeUrl: string;
    provisioningUrl?: string;
    schema: string;
}
export interface GenerationSpec {
    id: string;
    organizationId: string;
    collectionId: string;
    dimensions: number;
    metric: 'cosine';
    numericType: 'float32';
    indexType: IndexType;
    destinationFingerprint: string;
}
export interface PublicationSpec {
    id: string;
    documentId: string;
    sourceVersionId: string;
    expectedCount: number;
    manifestHash: string;
}
export interface VectorRow {
    chunkId: string;
    ordinal: number;
    chunkHash: string;
    vector: readonly number[];
}
export interface ManifestRow {
    chunkId: string;
    ordinal: number;
    chunkHash: string;
}
export interface SearchHit {
    chunkId: string;
    publicationId: string;
    distance: number;
}
export type VectorErrorCode =
    | 'INVALID_INPUT'
    | 'DESTINATION_DRIFT'
    | 'CAPABILITY_UNAVAILABLE'
    | 'SHAPE_MISMATCH'
    | 'STALE_EPOCH'
    | 'TOMBSTONED'
    | 'PUBLICATION_IMMUTABLE'
    | 'MANIFEST_MISMATCH'
    | 'STORE_UNAVAILABLE';
/** Raw driver errors/connection strings must never escape the adapter boundary. */
export class VectorStoreError extends Error {
    constructor(readonly code: VectorErrorCode) {
        super(code);
    }
}
