/** Guarded load-only adapter: no I/O occurs on import or before exact ownership admission. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
    createTrafficIngestionObserver,
    need,
    IngestionObservationError,
    INGESTION_LIMITS,
} from './load-traffic-ingestion-observer.mjs';
import {
    loadObserverGuard,
    producerIdentity,
    loadObservationPackages,
} from './load-observer-runtime.mjs';
import { readNativeSnapshot } from './load-observer-sql.mjs';
import { readIngestionProof } from './load-traffic-ingestion-observer-sql.mjs';
import {
    privateDirectory,
    readPrivate,
    privateCheckpoint,
} from './load-private.mjs';
import { same, validateIdentity } from './load-observer-core.mjs';
import { tinySource } from './load-traffic-ingestion.mjs';
export const STATIC_DRAFT_ONLY = false;
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);

/** Only code-pinned tiny fixtures can supply canonical bytes; no file path, extraction object or URL is followed. */
export function trafficCanonical(
    descriptor,
    runId,
    organizationId,
    fixture,
    documents
) {
    const match = /^m7c-traffic-(paced|closed-loop)-(A|B)-([123])\.txt$/u.exec(
        descriptor?.fixtureId ?? ''
    );
    need(
        match &&
            fixture.users[match[2] === 'A' ? 'owner' : 'foreign']
                .organizationId === organizationId,
        'LOAD_INGEST_DESCRIPTOR'
    );
    const expected = tinySource(
            runId,
            match[1],
            match[2],
            Number(match[3]) - 1
        ),
        { text, ...metadata } = expected;
    need(
        same(
            { ...descriptor, text: undefined },
            { ...metadata, text: undefined }
        ),
        'LOAD_INGEST_DESCRIPTOR'
    );
    return documents.decodeStoredExtraction(Buffer.from(text), 'utf8-text-v1');
}

/** Real PostgreSQL clients and private receipt files are inaccessible while this independent flag is true. */
export async function createTrafficIngestionRuntime({
    state,
    fixture,
    statePath,
    directory,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_INGEST_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    const runDirectory = path.join(
        ROOT,
        'node_modules/.cache/vectorix',
        state.prefix
    );
    need(
        statePath === path.join(runDirectory, 'state.json') &&
            directory === path.join(runDirectory, 'ingestion-native-receipts'),
        'LOAD_INGEST_PATH'
    );
    const admit = async () => {
        try {
            loadObserverGuard({ state, statePath });
            need(
                same(
                    JSON.parse(
                        readPrivate(statePath, 128 * 1024).toString('utf8')
                    ),
                    state
                ),
                'LOAD_INGEST_BINDING'
            );
        } catch (error) {
            if (error instanceof IngestionObservationError) throw error;
            throw new IngestionObservationError('LOAD_INGEST_GUARD');
        }
    };
    await admit();
    privateDirectory(directory);
    const { Client, chunking, documents, embeddings, vector } =
        await loadObservationPackages(admit);
    const dependencies = {
        identity: (value) => embeddings.modelIdentity.parse(value),
        prepare: embeddings.prepareEmbeddingInput,
        manifestHash: vector.manifestHash,
        generationTable: vector.generationTable,
        plan: (artifact, profile, identity, title) => {
            const children = [
                ...chunking
                    .resolveChunkingStrategy(
                        profile.chunkingStrategy,
                        'token-window-utf8-v1'
                    )
                    .plan(artifact, {
                        ...profile.chunking,
                        maxEmbeddingInputBytes:
                            embeddings.embeddingInputByteLimit(identity, {
                                kind: 'document',
                                title,
                                preparation: '',
                            }),
                        maxChunks: 2,
                    }),
            ];
            const parent = chunking.planParentContext(artifact, children, {
                parentMaxTokens: 2048,
            });
            return {
                children,
                parents: parent.parents,
                mapping: parent.childParentOrdinals,
            };
        },
    };
    const connection = async (key, operation) => {
        await admit();
        const client = new Client({
            connectionString: state.environment[key],
            connectionTimeoutMillis: 5000,
            query_timeout: 6000,
        });
        try {
            await client.connect();
            const result = await operation(client);
            await admit();
            return result;
        } catch (error) {
            if (error instanceof IngestionObservationError) throw error;
            throw new IngestionObservationError('LOAD_INGEST_DATABASE');
        } finally {
            await client.end().catch(() => {});
        }
    };
    const store = {
        write: async (name, value) => {
            need(
                /^ingestion-(baseline|receipt)-[a-f0-9]{64}\.json$/u.test(name),
                'LOAD_INGEST_PATH'
            );
            privateCheckpoint(path.join(directory, name), value, true);
        },
        read: async (name) => {
            need(
                /^ingestion-baseline-[a-f0-9]{64}\.json$/u.test(name),
                'LOAD_INGEST_PATH'
            );
            try {
                return JSON.parse(
                    readPrivate(
                        path.join(directory, name),
                        INGESTION_LIMITS.receiptBytes
                    ).toString('utf8')
                );
            } catch {
                throw new IngestionObservationError('LOAD_INGEST_RECEIPT');
            }
        },
    };
    return createTrafficIngestionObserver({
        state,
        fixture,
        admit,
        store,
        evidenceKind: 'LIVE_READ_ONLY',
        nowMicros: () => Math.floor(performance.now() * 1000),
        sleepMicros: (us) =>
            new Promise((resolve) => setTimeout(resolve, us / 1000)),
        reader: {
            native: (input) =>
                connection('DATABASE_URL', (client) =>
                    readNativeSnapshot(client, {
                        state,
                        input,
                        producerIdentitySha256: producerIdentity(state),
                    })
                ),
            snapshot: (input) =>
                connection('DATABASE_URL', (app) =>
                    connection('VECTOR_DATABASE_URL', (vx) =>
                        readIngestionProof(app, vx, {
                            state,
                            input,
                            dependencies: {
                                ...dependencies,
                                canonical: (descriptor) =>
                                    trafficCanonical(
                                        descriptor,
                                        state.runId,
                                        input.organizationId,
                                        fixture,
                                        documents
                                    ),
                            },
                        })
                    )
                ),
        },
    });
}
