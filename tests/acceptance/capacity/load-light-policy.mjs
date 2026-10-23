/** Explicit new experiment only. No live adapter or admission is implemented by this preparation. */
export const LIVE_IO_DISABLED = true;
export const POLICY_VERSION = 'native-light-load-v1';
export const NAMESPACE = 'vectorix-m7c-light-load';
export const VERSION = 'm7c-light-v1';
export const SEED = 'vectorix-m7c-light-default-2026-10-23-v1';
export const PROFILE = Object.freeze({
    targetTokens: 128,
    minTokens: 32,
    maxTokens: 192,
    overlapTokens: 16,
    maxEmbeddingInputBytes: 6144,
    maxChunks: 100000,
});
export const PARENT_PROFILE = Object.freeze({ parentMaxTokens: 512 });
export const CONTROL_PROFILE = Object.freeze({
    targetTokens: 512,
    minTokens: 128,
    maxTokens: 768,
    overlapTokens: 64,
    parentMaxTokens: 2048,
});
export const MODEL_REQUIREMENT = Object.freeze({
    provider: 'OLLAMA',
    model: 'embeddinggemma:latest',
    dimensions: 768,
    preset: 'EMBEDDING_GEMMA',
    preparation: '',
    metric: 'COSINE',
    numericType: 'FLOAT32',
    indexType: 'DISKANN',
    parentChild: true,
    expectedDigest:
        '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
});
export const LIMITS = Object.freeze({
    documents: 200,
    childrenPerDocument: 500,
    totalChildren: 100000,
    sourceBytes: 25 * 1024 ** 2,
    recordBytes: 192,
    pilotDocuments: 4,
    originalSourceBytes: 33609600,
});
export const RESOURCE_LIMITS = Object.freeze({
    postgres: Object.freeze({ cpus: '2', memoryBytes: 2 * 1024 ** 3 }),
    vector: Object.freeze({ cpus: '2', memoryBytes: 4 * 1024 ** 3 }),
    redis: Object.freeze({ cpus: '1', memoryBytes: 256 * 1024 ** 2 }),
    rustfs: Object.freeze({ cpus: '1', memoryBytes: 1024 ** 3 }),
    ollama: Object.freeze({ cpus: '4', memoryBytes: 6 * 1024 ** 3 }),
});
export const FINITE_GATES = Object.freeze({
    setupMs: 1200000,
    pilotMs: 1200000,
    sourceImportMs: 1200000,
    fullIndexMs: 7200000,
    scaleFactor: 50,
    phaseMicros: 180000000,
    drainMicros: 300000000,
    minimumFreeBytes: 4 * 1024 ** 3,
    maximumDocuments: 240,
    maximumCollections: 20,
    searchSlots: 10,
    searchSlotsPerOrganization: 5,
    maximumSearchesPerPhase: 10000,
    nativeParallelSlots: 1,
});
/** Frozen roles prevent a global primary-profile change from silently changing B or ingestion controls. */
export function profileForRole(role) {
    if (role === 'pilotA' || role === 'primaryA')
        return { ...PROFILE, ...PARENT_PROFILE };
    if (['referenceB', 'ingestionA', 'ingestionB'].includes(role))
        return { ...CONTROL_PROFILE };
    throw Error('LIGHT_PROFILE_ROLE');
}
