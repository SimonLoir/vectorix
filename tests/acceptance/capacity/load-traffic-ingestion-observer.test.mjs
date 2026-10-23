/** Only local synthetic documents, injected numeric observations and mock SQL are used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fields, sha, digest } from './load-observer-core.mjs';
import {
    createTrafficIngestionObserver,
    ingestionNativeDelta,
    checkedIngestionCatalog,
} from './load-traffic-ingestion-observer.mjs';
import { validateIngestionInventory } from './load-traffic-ingestion-observer-history.mjs';
import {
    readIngestionProof,
    ingestionReadonly,
} from './load-traffic-ingestion-observer-sql.mjs';
import {
    createTrafficIngestionRuntime,
    STATIC_DRAFT_ONLY,
    trafficCanonical,
} from './load-traffic-ingestion-observer-runtime.mjs';
import { tinySource } from './load-traffic-ingestion.mjs';
import { loadProfile, LOAD_IDENTITY } from './load-import-core.mjs';
import * as documents from '../../../packages/documents/src/index.ts';
import {
    resolveChunkingStrategy,
    planParentContext,
} from '../../../packages/chunking/src/index.ts';
import { prepareEmbeddingInput } from '../../../packages/embeddings/src/preparation.ts';
import {
    manifestHash,
    generationTable,
} from '../../../packages/vector-store/src/index.ts';
const run = '0123456789ab',
    uuid = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
const state = {
    schemaVersion: 1,
    namespace: 'vectorix-m7c-load',
    runId: run,
    applicationDatabase: `vectorix_m7c_load_app_${run}_test`,
    vectorDatabase: `vectorix_m7c_load_vectors_${run}_test`,
    ports: { postgres: 15432, vector: 15433 },
    environment: {
        DATABASE_URL: `postgresql://postgres:test@127.0.0.1:15432/vectorix_m7c_load_app_${run}_test`,
        VECTOR_DATABASE_URL: `postgresql://runtime:test@127.0.0.1:15433/vectorix_m7c_load_vectors_${run}_test`,
        VECTORIX_DEFAULT_OLLAMA_ENDPOINT: 'http://127.0.0.1:11435',
    },
    loadPolicy: { model: { digest: LOAD_IDENTITY.weights } },
};
const fixture = {
    namespace: state.namespace,
    runId: run,
    organizationIds: ['orgA', 'orgB'],
    users: {
        owner: { userId: 'owner', organizationId: 'orgA' },
        reader: { userId: 'reader', organizationId: 'orgA' },
        foreign: { userId: 'foreign', organizationId: 'orgB' },
    },
};
const input = {
    phase: 'paced',
    organizationId: 'orgA',
    collectionId: uuid(1),
    generationId: uuid(2),
};
const identity = {
    schemaVersion: 1,
    provider: 'OLLAMA',
    model: 'embeddinggemma:latest',
    digest: LOAD_IDENTITY.weights,
    contextTokens: 8192,
    preset: 'EMBEDDING_GEMMA',
    dimensions: 768,
};
const dependencies = {
    prepare: prepareEmbeddingInput,
    manifestHash,
    generationTable,
    identity: (value) => value,
    canonical: (descriptor) =>
        trafficCanonical(descriptor, run, 'orgA', fixture, documents),
    plan: (artifact, profile) => {
        const children = [
                ...resolveChunkingStrategy(
                    'TOKEN_WINDOW',
                    'token-window-utf8-v1'
                ).plan(artifact, {
                    ...profile.chunking,
                    maxChunks: 2,
                    maxEmbeddingInputBytes: 8160,
                }),
            ],
            parent = planParentContext(artifact, children, {
                parentMaxTokens: 2048,
            });
        return {
            children,
            parents: parent.parents,
            mapping: parent.childParentOrdinals,
        };
    },
};

function inventory(history = true, phase = 'paced') {
    const descriptors = Array.from(
            { length: phase === 'paced' ? 3 : 6 },
            (_, i) => {
                const { text, ...descriptor } = tinySource(
                    run,
                    i < 3 ? 'paced' : 'closed-loop',
                    'A',
                    i % 3
                );
                return descriptor;
            }
        ),
        bindings = descriptors.map((row, i) => ({
            fixtureId: row.fixtureId,
            documentId: uuid(10 + i),
            versionId: uuid(20 + i),
        }));
    const value = {
        input: { ...input, phase, bindings, descriptors },
        generation: {
            id: input.generationId,
            organizationId: 'orgA',
            collectionId: input.collectionId,
            ...loadProfile(),
            status: 'ACTIVE',
            activeGenerationId: input.generationId,
            deletedAt: null,
            configurationRevision: 1,
            modelIdentity: identity.digest,
            identity,
            chunkerVersion: 'token-window-utf8-v1',
            parentContextVersion: 'parent-context-utf8-v1',
            endpoint: state.environment.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
            vectorSchema: 'vector_collections',
            tableName: generationTable(input.generationId),
            contentSequence: '6',
            appliedSequence: '6',
            projectedChunks: String(bindings.length),
            activeChunks: String(bindings.length),
            retainedChunks: '0',
            reservedChunks: '0',
        },
        candidates: [],
        desired: [],
        associations: [],
        tasks: [],
        rows: [],
        physical: [],
        ledgers: [],
        plans: [],
        dependencies,
        identity,
    };
    for (let i = 0; i < bindings.length; i++) {
        const descriptor = descriptors[i],
            binding = bindings[i],
            artifact = dependencies.canonical(descriptor),
            planned = {
                artifact,
                ...dependencies.plan(artifact, loadProfile()),
            };
        value.plans.push(planned);
        const candidate = {
            id: uuid(30 + i),
            organizationId: 'orgA',
            generationId: input.generationId,
            documentId: binding.documentId,
            sourceVersionId: binding.versionId,
            extractionId: uuid(40 + i),
            status: 'PUBLISHED',
            chunkCount: 1,
            materializedChunks: 1,
            manifestHash: null,
            fileName: descriptor.fileName,
            mediaType: 'text/plain',
            extractorVersion: 'utf8-text-v1',
            vectorSealedAt: new Date(0),
            publishedAt: new Date(1),
            metadataRevision: 2,
            buildRevision: 2,
            sourceChangeSequence: '2',
            language: descriptor.language,
            tags: descriptor.tags,
            metadata: descriptor.metadata,
            sha256: descriptor.originalSha256,
            version: 1,
            sourceStatus: 'READY',
            sourceState: 'AVAILABLE',
            ingestionStatus: 'READY',
            ingestionReservedBytes: '0',
            discardedAt: null,
            extractionDiscardedAt: null,
            holdState: 'LIVE',
        };
        const child = {
            id: uuid(50 + i),
            organizationId: 'orgA',
            generationId: input.generationId,
            indexedDocumentId: candidate.id,
            ordinal: 0,
            kind: 'CHILD',
            text: planned.children[0].text,
            textHash: sha(planned.children[0].text),
            embeddingInputHash: sha(
                prepareEmbeddingInput(
                    identity,
                    'document',
                    planned.children[0].text,
                    { title: candidate.fileName, preparation: '' }
                )
            ),
            startOffset: planned.children[0].start,
            endOffset: planned.children[0].end,
            parentId: uuid(60 + i),
            tokenCount: planned.children[0].tokenCount,
            tokenCountIsEstimate: true,
            sourceSpanCount: planned.children[0].sourceSpans.length,
            sourceSpans: planned.children[0].sourceSpans,
        };
        const parent = {
            ...child,
            id: uuid(60 + i),
            ordinal: 1,
            kind: 'PARENT',
            text: planned.parents[0].text,
            textHash: sha(planned.parents[0].text),
            embeddingInputHash: null,
            parentId: null,
            startOffset: planned.parents[0].start,
            endOffset: planned.parents[0].end,
            tokenCount: planned.parents[0].tokenCount,
            sourceSpans: planned.parents[0].sourceSpans,
            sourceSpanCount: planned.parents[0].sourceSpans.length,
        };
        candidate.manifestHash = manifestHash([
            { chunkId: child.id, ordinal: 0, chunkHash: child.textHash },
        ]);
        value.candidates.push(candidate);
        value.rows.push(child, parent);
        value.physical.push({
            chunk_id: child.id,
            publication_id: candidate.id,
            source_version_id: candidate.sourceVersionId,
            document_id: candidate.documentId,
            generation_id: candidate.generationId,
            ordinal: 0,
            chunk_hash: child.textHash,
            dimensions: 768,
            finite_nonzero: true,
        });
        value.ledgers.push({
            id: candidate.id,
            document_id: candidate.documentId,
            source_version_id: candidate.sourceVersionId,
            expected_count: 1,
            manifest_hash: candidate.manifestHash,
            state: 'SEALED',
        });
        value.desired.push({
            documentId: candidate.documentId,
            desiredVersionId: candidate.sourceVersionId,
            desiredExtractionId: candidate.extractionId,
            desiredMetadataRevision: 2,
            desiredChangeSequence: '2',
            buildRevision: 2,
            targetChunkCount: 1,
            publishedIndexedDocumentId: candidate.id,
            removedAt: null,
        });
        value.associations.push({
            documentId: candidate.documentId,
            metadataRevision: 2,
            metadata: candidate.metadata,
            language: candidate.language,
            tags: candidate.tags,
        });
        value.tasks.push({
            organizationId: 'orgA',
            generationId: input.generationId,
            kind: 'INDEX_DOCUMENT',
            status: 'COMPLETE',
            indexedDocumentId: candidate.id,
            reservedChunks: 0,
        });
    }
    if (history) {
        const current = value.candidates[0],
            old = {
                ...current,
                id: uuid(70),
                status: 'CLEANING',
                holdState: 'RETIRED',
                metadataRevision: 1,
                buildRevision: 1,
                language: 'UNDETERMINED',
                tags: [],
                metadata: {},
            };
        const child = {
                ...value.rows[0],
                id: uuid(71),
                indexedDocumentId: old.id,
                parentId: uuid(72),
            },
            parent = {
                ...value.rows[1],
                id: uuid(72),
                indexedDocumentId: old.id,
            };
        old.manifestHash = manifestHash([
            { chunkId: child.id, ordinal: 0, chunkHash: child.textHash },
        ]);
        value.candidates.push(old);
        value.rows.push(child, parent);
        value.ledgers.push({
            ...value.ledgers[0],
            id: old.id,
            state: 'TOMBSTONED',
            manifest_hash: old.manifestHash,
        });
        value.tasks.push(
            {
                organizationId: 'orgA',
                generationId: input.generationId,
                kind: 'INDEX_DOCUMENT',
                status: 'COMPLETE',
                indexedDocumentId: old.id,
                reservedChunks: 0,
            },
            {
                organizationId: 'orgA',
                generationId: input.generationId,
                kind: 'CLEAN_PUBLICATION',
                status: 'PROCESSING',
                indexedDocumentId: old.id,
                reservedChunks: 0,
            }
        );
        const partial = {
            ...current,
            id: uuid(73),
            status: 'RETIRED',
            holdState: 'RETIRED',
            materializedChunks: 0,
            manifestHash: null,
            publishedAt: null,
            vectorSealedAt: null,
        };
        value.candidates.push(partial);
        value.rows.push({
            ...parent,
            id: uuid(74),
            indexedDocumentId: partial.id,
        });
        value.tasks.push(
            {
                organizationId: 'orgA',
                generationId: input.generationId,
                kind: 'INDEX_DOCUMENT',
                status: 'CANCELLED',
                indexedDocumentId: partial.id,
                reservedChunks: 1,
            },
            {
                organizationId: 'orgA',
                generationId: input.generationId,
                kind: 'CLEAN_PUBLICATION',
                status: 'FAILED',
                indexedDocumentId: partial.id,
                reservedChunks: 0,
            }
        );
        const cleaned = {
            ...current,
            id: uuid(75),
            status: 'CLEANED',
            holdState: 'RELEASED',
            materializedChunks: 0,
        };
        value.candidates.push(cleaned);
        value.tasks.push({
            organizationId: 'orgA',
            generationId: input.generationId,
            kind: 'INDEX_DOCUMENT',
            status: 'CANCELLED',
            indexedDocumentId: cleaned.id,
            reservedChunks: 0,
        });
        value.generation.retainedChunks = '1';
        value.generation.reservedChunks = '1';
    }
    value.tasks = value.tasks.map((task, index) => ({
        ...task,
        attempts: index === 0 ? 2 : 1,
        continuations: 0,
        errorCode: null,
    }));
    return value;
}
const snap = (overrides = {}) => ({
    organizationId: 'orgA',
    collectionId: input.collectionId,
    producerIdentitySha256: 'a'.repeat(64),
    knownGapReports: '0',
    quiescent: true,
    exclusive: true,
    hours: ['2026-10-23T00:00:00.000Z'],
    counters: {
        ...Object.fromEntries(fields.map((key) => [key, '0'])),
        ...overrides,
    },
});
const finalNative = snap({
    recordedStarts: '5',
    recordedSuccesses: '3',
    recordedFailures: '1',
    recordedSupersessions: '1',
    nativeStarts: '5',
    nativeValidatedBatches: '4',
    nativeFailedBatches: '1',
    validatedVectors: '4',
    dispatchedPreparedBytes: '500',
    validatedPreparedBytes: '400',
    validatedEstimatedInputTokens: '101',
    knownProviderInputTokens: '99',
});

test('current tiny rows and retained partial/cleaned/tombstoned history conserve A/R/U independently of physical count', () => {
    const value = inventory(),
        result = validateIngestionInventory(value);
    assert.deepEqual(result.accounting, {
        activeChildren: '3',
        retainedChildren: '1',
        reservedChildren: '1',
    });
    assert.deepEqual(result.retained, {
        candidates: 3,
        children: 1,
        physicalChildren: 0,
    });
    assert.equal(result.history.cleanupFailedTasks, 1);
    assert.equal(result.history.partialLayoutCandidates, 1);
    assert.equal(result.history.observedAdditionalIndexAttempts, 1);
    assert.equal(result.cleanupHealth, 'UNRESOLVED_FAILED_CLEANUP');
    assert.equal(result.failedOutstandingCleanupTasks, 1);
    assert.equal(checkedIngestionCatalog(result), result);
    assert.equal(
        validateIngestionInventory(inventory(false, 'closed-loop'))
            .currentDocuments,
        6
    );
});
test('cleanup failure stays a gate until real-state acknowledgement, while scheduled retention remains allowed', () => {
    const value = inventory();
    value.tasks.find(
        (task) => task.kind === 'CLEAN_PUBLICATION' && task.status === 'FAILED'
    ).status = 'PENDING';
    assert.equal(validateIngestionInventory(value).cleanupHealth, 'CLEAN');
    const cleaned = value.candidates.find(
        (candidate) => candidate.status === 'CLEANED'
    );
    value.tasks.push({
        organizationId: 'orgA',
        generationId: input.generationId,
        kind: 'CLEAN_PUBLICATION',
        status: 'FAILED',
        indexedDocumentId: cleaned.id,
        reservedChunks: 0,
        attempts: 1,
        continuations: 0,
        errorCode: 'PROCESSING_FAILED',
    });
    const result = validateIngestionInventory(value);
    assert.equal(result.history.cleanupFailedTasks, 1);
    assert.equal(result.failedOutstandingCleanupTasks, 0);
    assert.equal(result.cleanupHealth, 'CLEAN');
});
test('complete current work cannot retain a consistent leaked reservation or lack its committed completion', () => {
    for (const change of [
        (v) => {
            v.tasks[0].reservedChunks = 1;
            v.generation.reservedChunks = '2';
        },
        (v) => (v.tasks[0].status = 'CANCELLED'),
        (v) => v.tasks.splice(0, 1),
    ]) {
        const value = inventory();
        change(value);
        assert.throws(() => validateIngestionInventory(value), {
            code: 'LOAD_INGEST_TASK',
        });
    }
});
test('retained OPEN/SEALED ledgers prove complete canonical manifests and exact physical rows, including before cleanup', () => {
    const value = inventory(),
        old = value.candidates.find(
            (candidate) => candidate.status === 'CLEANING'
        ),
        ledger = value.ledgers.find((row) => row.id === old.id),
        child = value.rows.find(
            (row) => row.indexedDocumentId === old.id && row.kind === 'CHILD'
        );
    ledger.state = 'OPEN';
    assert.equal(
        validateIngestionInventory(value).retained.physicalChildren,
        0
    );
    ledger.state = 'SEALED';
    value.physical.push({
        ...value.physical[0],
        chunk_id: child.id,
        publication_id: old.id,
        chunk_hash: child.textHash,
    });
    assert.equal(
        validateIngestionInventory(value).retained.physicalChildren,
        1
    );
    const partial = value.candidates.find(
        (candidate) => candidate.status === 'RETIRED'
    );
    value.ledgers.push({ ...ledger, id: partial.id, state: 'OPEN' });
    assert.throws(() => validateIngestionInventory(value), {
        code: 'LOAD_INGEST_LEDGER',
    });
});
test('current exact metadata/version/parent/hash/vector/manifest violations and unresolved tasks fail closed', () => {
    for (const change of [
        (v) => (v.candidates[0].sourceVersionId = uuid(99)),
        (v) => (v.desired[0].desiredChangeSequence = '1'),
        (v) => (v.associations[0].language = 'FR'),
        (v) => (v.rows[0].parentId = null),
        (v) => (v.rows[0].embeddingInputHash = 'a'.repeat(64)),
        (v) => (v.physical[0].document_id = 'foreign'),
        (v) => (v.ledgers[0].manifest_hash = 'a'.repeat(64)),
        (v) => (v.tasks[0].status = 'FAILED'),
        (v) => (v.generation.retainedChunks = '0'),
        (v) => (v.generation.reservedChunks = '0'),
        (v) =>
            v.rows.push({
                ...v.rows[0],
                id: uuid(98),
                indexedDocumentId: uuid(97),
            }),
        (v) =>
            v.physical.push({
                ...v.physical[0],
                chunk_id: uuid(98),
                publication_id: uuid(97),
            }),
        (v) => (v.candidates.at(-1).materializedChunks = 1),
    ]) {
        const value = inventory();
        change(value);
        assert.throws(() => validateIngestionInventory(value));
    }
});
test('native deltas retain supersessions, recovered errors, retries, extra validated work, unknown tokens and reported gaps', () => {
    const result = ingestionNativeDelta(snap(), finalNative);
    assert.equal(result.counters.nativeValidatedBatches, '4');
    assert.equal(result.counters.nativeFailedBatches, '1');
    assert.equal(result.counters.recordedSupersessions, '1');
    assert.equal(result.providerInputTokens, null);
    assert.equal(result.counters.knownProviderInputTokens, '99');
    assert.equal(result.knownInFlightBatches, '0');
    const success = structuredClone(finalNative);
    success.counters.nativeFailedBatches = '0';
    success.counters.nativeStarts = '4';
    assert.equal(
        ingestionNativeDelta(snap(), success).providerInputTokens,
        '99'
    );
    success.knownGapReports = '1';
    assert.equal(
        ingestionNativeDelta(snap(), success).providerInputTokens,
        null
    );
    const unknown = structuredClone(finalNative);
    unknown.knownGapReports = '1';
    unknown.counters.unknownProviderTokenBatches = '1';
    assert.equal(
        ingestionNativeDelta(snap(), unknown).providerInputTokens,
        null
    );
    assert.equal(
        ingestionNativeDelta(snap(), unknown).coverage,
        'PARTIAL_KNOWN_GAP'
    );
    for (const change of [
        (v) => (v.producerIdentitySha256 = 'b'.repeat(64)),
        (v) => (v.counters.nativeStarts = '4'),
        (v) => (v.hours = []),
        (v) => (v.counters.recordedStarts = '-1'),
    ]) {
        const invalid = structuredClone(finalNative);
        change(invalid);
        assert.throws(() => ingestionNativeDelta(snap(), invalid));
    }
});
test('immutable phase receipts bind actual stable observations and refuse unexpected content or replay', async () => {
    const data = inventory(),
        catalog = validateIngestionInventory(data),
        files = new Map();
    let time = 0,
        current = snap();
    const observer = createTrafficIngestionObserver({
        state,
        fixture,
        admit: async () => {},
        reader: { native: async () => current, snapshot: async () => catalog },
        store: {
            write: async (name, value) => {
                assert(!files.has(name));
                files.set(name, structuredClone(value));
            },
            read: async (name) => structuredClone(files.get(name)),
        },
        nowMicros: () => time,
        sleepMicros: async (value) => {
            time += value;
        },
    });
    const baselineRef = await observer.begin(input);
    current = finalNative;
    const request = {
        ...data.input,
        newBindings: data.input.bindings,
        priorBindings: [],
        baselineRef,
        deadlineMicros: 300000000,
    };
    const result = await observer.finish(request);
    assert.equal(result.evidenceKind, 'SYNTHETIC_UNIT_TEST');
    assert.equal(result.native.counters.nativeFailedBatches, '1');
    assert.equal(files.size, 2);
    const receipt = [...files.values()].find(
        (value) => value.kind === 'INGESTION_PHASE_PROOF'
    );
    assert.equal(digest(receipt), result.native.receiptSha256);
    assert.equal(result.retained.children, 1);
    await assert.rejects(() => observer.finish(request), {
        code: 'LOAD_INGEST_REPLAY',
    });
    assert.throws(() =>
        checkedIngestionCatalog({ ...catalog, rawText: 'forbidden' })
    );
    assert.throws(() =>
        checkedIngestionCatalog({
            ...catalog,
            history: { ...catalog.history, rawError: 'forbidden' },
        })
    );
});
test('lost deadlines, unfinished native batches and cross-phase bindings never write a success receipt', async () => {
    for (const mode of ['deadline', 'unfinished', 'extra-native-field']) {
        let time = 0,
            started = false;
        const files = new Map(),
            data = inventory();
        const observer = createTrafficIngestionObserver({
            state,
            fixture,
            admit: async () => {},
            reader: {
                native: async () =>
                    mode === 'extra-native-field'
                        ? { ...snap(), rawResponse: 'forbidden' }
                        : started
                          ? mode === 'unfinished'
                              ? snap({ nativeStarts: '1' })
                              : finalNative
                          : snap(),
                snapshot: async () => validateIngestionInventory(data),
            },
            store: {
                write: async (name, value) => files.set(name, value),
                read: async (name) => files.get(name),
            },
            nowMicros: () => time,
            sleepMicros: async (value) => {
                time += value;
            },
        });
        if (mode === 'extra-native-field') {
            await assert.rejects(() => observer.begin(input), {
                code: 'LOAD_INGEST_NATIVE',
            });
            continue;
        }
        const baselineRef = await observer.begin(input);
        started = true;
        await assert.rejects(() =>
            observer.finish({
                ...data.input,
                newBindings: data.input.bindings,
                baselineRef,
                deadlineMicros: time + (mode === 'deadline' ? 1 : 20000000),
            })
        );
        assert.equal(files.size, 1);
    }
});
test('code-pinned tiny canonical reconstruction preserves UTF16 accents/surrogates and refuses cross-org or altered descriptors', async () => {
    const source = tinySource(run, 'paced', 'A', 1),
        { text, ...descriptor } = source,
        artifact = trafficCanonical(
            descriptor,
            run,
            'orgA',
            fixture,
            documents
        );
    assert.equal(artifact.text, text);
    assert.equal(sha(artifact.text), descriptor.canonicalSha256);
    assert(text.includes('cafe\u0301 🧭'));
    assert.throws(() =>
        trafficCanonical(descriptor, run, 'orgB', fixture, documents)
    );
    assert.throws(() =>
        trafficCanonical(
            { ...descriptor, tags: ['changed'] },
            run,
            'orgA',
            fixture,
            documents
        )
    );
    await assert.rejects(() => createTrafficIngestionRuntime({ state: null }), {
        code: STATIC_DRAFT_ONLY
            ? 'LOAD_INGEST_RUNTIME_DISABLED'
            : 'LOAD_OBS_SCOPE',
    });
});

function sqlMock(value, kind, queries) {
    return {
        async query(sql, args) {
            queries.push({ sql, args });
            if (
                sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
                sql === 'COMMIT' ||
                sql === 'ROLLBACK' ||
                sql.startsWith('SET LOCAL')
            )
                return { rows: [] };
            if (sql.includes('current_database()'))
                return {
                    rows: [
                        {
                            database:
                                kind === 'app'
                                    ? state.applicationDatabase
                                    : state.vectorDatabase,
                            readonly: 'on',
                        },
                    ],
                };
            if (sql.startsWith('SELECT (SELECT count'))
                return {
                    rows: [
                        {
                            versions: value.input.bindings.length,
                            generations: 1,
                        },
                    ],
                };
            if (sql.startsWith('SELECT g.id'))
                return { rows: [value.generation] };
            if (sql.includes('FROM "IndexedDocument" p'))
                return { rows: value.candidates };
            if (sql.includes('FROM "GenerationDocument"'))
                return { rows: value.desired };
            if (sql.includes('FROM "CollectionDocument"'))
                return { rows: value.associations };
            if (sql.includes('FROM "IndexTask"')) return { rows: value.tasks };
            if (sql.includes('FROM "Chunk"')) return { rows: value.rows };
            if (sql.includes('vx_identity'))
                return { rows: [{ identity: 'test-instance', version: 1 }] };
            if (sql.includes('vx_generations'))
                return {
                    rows: [
                        {
                            organization_id: 'orgA',
                            collection_id: input.collectionId,
                            destination_fingerprint:
                                value.generation.destinationFingerprint,
                            shape: {
                                dimensions: 768,
                                metric: 'cosine',
                                indexType: 'DISKANN',
                                numericType: 'float32',
                            },
                            state: 'READY',
                        },
                    ],
                };
            if (sql.includes('vx_publications')) return { rows: value.ledgers };
            if (sql.includes('public.vector_dims'))
                return { rows: value.physical };
            throw Error('UNEXPECTED_SYNTHETIC_SQL');
        },
    };
}
test('mocked read-only app/vector path projects bounded provenance and returns only fixed aggregates', async () => {
    const value = inventory(),
        queries = [];
    value.generation.destinationFingerprint = sha(
        JSON.stringify([
            '127.0.0.1',
            '15433',
            state.vectorDatabase,
            'vector_collections',
            'disable',
            'postgres',
            'false',
            false,
        ]) + ':test-instance'
    );
    const proof = await readIngestionProof(
        sqlMock(value, 'app', queries),
        sqlMock(value, 'vector', queries),
        { state, input: value.input, dependencies }
    );
    assert.equal(proof.currentDocuments, 3);
    assert.equal(proof.retained.children, 1);
    assert.equal(queries.filter((value) => value.sql === 'COMMIT').length, 2);
    assert(
        queries.some(
            (value) =>
                value.sql.includes('jsonb_array_elements') &&
                value.sql.includes('LIMIT 64')
        )
    );
    assert(
        queries.every(
            (value) =>
                !/^\s*(UPDATE|DELETE|INSERT|CREATE|ALTER|DROP)/iu.test(
                    value.sql
                )
        )
    );
    assert(!JSON.stringify(proof).includes('Synthetic document'));
});
test('read-only transaction checks real database identity and rolls back on early/late budget failures', async () => {
    const queries = [];
    const wrong = {
        query: async (sql) => {
            queries.push(sql);
            return {
                rows: sql.includes('current_database()')
                    ? [{ database: 'production', readonly: 'on' }]
                    : [],
            };
        },
    };
    await assert.rejects(
        () =>
            ingestionReadonly(wrong, state.applicationDatabase, async () => {}),
        { code: 'LOAD_INGEST_DATABASE' }
    );
    assert.equal(queries.at(-1), 'ROLLBACK');
    let time = 0;
    const slow = {
        query: async (sql) => {
            queries.push(sql);
            if (sql.startsWith('BEGIN')) time = 2;
            return { rows: [] };
        },
    };
    await assert.rejects(
        () =>
            ingestionReadonly(slow, state.applicationDatabase, async () => {}, {
                now: () => time,
                deadline: 1,
            }),
        { code: 'LOAD_INGEST_DEADLINE' }
    );
    assert.equal(queries.at(-1), 'ROLLBACK');
});
