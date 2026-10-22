import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@repo/db';
import {
    VectorStore,
    VectorStoreError,
    generationTable,
    type DestinationConfig,
    type GenerationSpec,
} from '@repo/vector-store';

/** Non-secret destination snapshot prepared before the short catalog transaction. */
export interface PreparedVectorDestination {
    organizationId: string;
    vectorConnectionId: string;
    schema: string;
    destinationFingerprint: string;
}

type Mode = 'runtime' | 'provision';
const stores = new Map<string, VectorStore>();

/** Read operator-owned deployment settings only when indexing/retrieval uses them. */
function platformConfiguration(mode: Mode): DestinationConfig {
    const runtimeUrl = process.env.VECTOR_DATABASE_URL;
    const provisioningUrl = process.env.VECTOR_DATABASE_PROVISIONING_URL;
    const schema = process.env.VECTOR_DATABASE_SCHEMA ?? 'vector_collections';
    if (!runtimeUrl || (mode === 'provision' && !provisioningUrl))
        throw new VectorStoreError('CAPABILITY_UNAVAILABLE');
    return {
        runtimeUrl,
        ...(mode === 'provision' ? { provisioningUrl } : {}),
        schema,
    };
}

/** Pool cache keys are hashes; credentials and raw driver errors never leave this module. */
function platformStore(mode: Mode) {
    const configuration = platformConfiguration(mode);
    const key = createHash('sha256')
        .update(JSON.stringify(configuration))
        .digest('hex');
    let store = stores.get(key);
    if (!store) {
        store = new VectorStore(configuration);
        stores.set(key, store);
    }
    return { store, schema: configuration.schema };
}

/**
 * Workers initialize ledgers lazily, outside application transactions. API startup
 * must never call this provisioning boundary. Absence/failure is an indexing
 * error; the notification and document processors remain independent.
 */
export async function initializeVectorDestination() {
    const { store } = platformStore('provision');
    return await store.initialize();
}

/**
 * Probe an organization-scoped platform destination without DDL. Re-read its
 * persistent database identity on every preparation, including pooled reconnects.
 * Call outside application transactions: this performs vector-network I/O.
 */
export async function prepareVectorDestination(
    db: PrismaClient,
    organizationId: string,
    vectorConnectionId: string
): Promise<PreparedVectorDestination> {
    const connection = await db.vectorConnection.findFirst({
        where: { organizationId, id: vectorConnectionId, key: 'platform' },
    });
    if (!connection) throw new VectorStoreError('DESTINATION_DRIFT');
    const { store, schema } = platformStore('runtime');
    if (connection.schema !== schema)
        throw new VectorStoreError('DESTINATION_DRIFT');
    const destinationFingerprint = await store.initialize();
    if (
        connection.destinationFingerprint !== null &&
        connection.destinationFingerprint !== destinationFingerprint
    )
        throw new VectorStoreError('DESTINATION_DRIFT');
    return {
        organizationId,
        vectorConnectionId,
        schema,
        destinationFingerprint,
    };
}

/**
 * Compare-and-set only the already-probed binding in the caller's catalog
 * transaction. No network or DDL occurs while that transaction holds its locks.
 * Existing bindings cannot silently adopt a different database after data loss.
 */
export async function bindVectorDestination(
    db: Prisma.TransactionClient,
    prepared: PreparedVectorDestination
) {
    const bound = await db.vectorConnection.updateMany({
        where: {
            id: prepared.vectorConnectionId,
            organizationId: prepared.organizationId,
            key: 'platform',
            schema: prepared.schema,
            OR: [
                { destinationFingerprint: null },
                { destinationFingerprint: prepared.destinationFingerprint },
            ],
        },
        data: { destinationFingerprint: prepared.destinationFingerprint },
    });
    if (bound.count !== 1) throw new VectorStoreError('DESTINATION_DRIFT');
    return prepared;
}

/**
 * Load an immutable generation and its saved profile, then verify the physical
 * destination and generated identifier. A caller must still enforce current
 * collection authorization/status before reading, publishing or cleanup.
 * Call outside application transactions: this performs vector-network I/O.
 */
export async function generationVectorAdapter(
    db: PrismaClient,
    organizationId: string,
    generationId: string,
    options: { provision?: boolean } = {}
) {
    const generation = await db.indexGeneration.findFirst({
        where: { organizationId, id: generationId },
        include: { configuration: true, vectorConnection: true },
    });
    if (!generation) throw new VectorStoreError('SHAPE_MISMATCH');
    const configuration = generation.configuration;
    const connection = generation.vectorConnection;
    const { store, schema } = platformStore(
        options.provision ? 'provision' : 'runtime'
    );
    if (
        connection.key !== 'platform' ||
        connection.organizationId !== organizationId ||
        configuration.organizationId !== organizationId ||
        configuration.collectionId !== generation.collectionId ||
        configuration.revision !== generation.configurationRevision ||
        configuration.vectorConnectionId !== connection.id ||
        generation.vectorConnectionId !== connection.id ||
        connection.schema !== schema ||
        generation.vectorSchema !== schema ||
        generation.tableName !== generationTable(generation.id) ||
        connection.destinationFingerprint !== generation.destinationFingerprint
    )
        throw new VectorStoreError('DESTINATION_DRIFT');
    if (
        configuration.metric !== 'cosine' ||
        configuration.numericType !== 'float32' ||
        !['HNSW', 'DISKANN'].includes(configuration.indexType)
    )
        throw new VectorStoreError('CAPABILITY_UNAVAILABLE');
    const fingerprint = await store.initialize();
    if (fingerprint !== generation.destinationFingerprint)
        throw new VectorStoreError('DESTINATION_DRIFT');
    const spec: GenerationSpec = {
        id: generation.id,
        organizationId,
        collectionId: generation.collectionId,
        destinationFingerprint: fingerprint,
        dimensions: configuration.dimensions,
        metric: 'cosine',
        numericType: 'float32',
        indexType: configuration.indexType === 'HNSW' ? 'HNSW' : 'DISKANN',
    };
    return { store, spec, generation, configuration };
}

/** Close cached pools during graceful shutdown and isolated test teardown. */
export async function closeVectorAdapters() {
    const current = [...stores.values()];
    stores.clear();
    await Promise.all(current.map((store) => store.close()));
}
