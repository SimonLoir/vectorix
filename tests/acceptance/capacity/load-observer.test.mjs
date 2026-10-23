import {
    experimentFields,
    fixturePolicyFields,
    roleFields,
} from './load-observer.test-helper.mjs';
/** Synthetic counters, local source bytes and mocked SQL only. No resource adapter is enabled. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    fields,
    digest,
    sha,
    nativeDelta,
    stableNativeSnapshot,
    validateIdentity,
} from './load-observer-core.mjs';
import { createLoadObserver } from './load-observer.mjs';
import {
    readNativeSnapshot,
    readGenerationProof,
} from './load-observer-sql.mjs';
import {
    createLoadObservationRuntime,
    STATIC_DRAFT_ONLY,
} from './load-observer-runtime.mjs';
import { validateDocumentLayout } from './load-observer-layout.mjs';
import { planDocument } from './load-corpus.mjs';
import { prepareEmbeddingInput } from '../../../packages/embeddings/src/preparation.ts';
import {
    resolveChunkingStrategy,
    planParentContext,
} from '../../../packages/chunking/src/index.ts';
import {
    manifestHash,
    generationTable,
} from '../../../packages/vector-store/src/index.ts';
import { loadProfile, LOAD_IDENTITY } from './load-import-core.mjs';
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
    ...experimentFields(),
};
const fixture = {
    ...fixturePolicyFields(),
    schemaVersion: 1,
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
    ...roleFields('pilotA'),
    runId: run,
    organizationId: 'orgA',
    collectionId: uuid(1),
    generationId: uuid(2),
    configurationRevision: 1,
    nativeIdentity: LOAD_IDENTITY.weights,
    dimensions: 768,
};
function snapshot(delta = {}) {
    return {
        organizationId: 'orgA',
        collectionId: input.collectionId,
        producerIdentitySha256: 'a'.repeat(64),
        knownGapReports: '0',
        quiescent: true,
        exclusive: true,
        hours: ['2026-10-23T00:00:00.000Z'],
        counters: {
            ...Object.fromEntries(fields.map((field) => [field, '0'])),
            ...delta,
        },
    };
}
const before = snapshot(),
    after = snapshot({
        recordedStarts: '1',
        recordedSuccesses: '1',
        nativeStarts: '1',
        nativeValidatedBatches: '1',
        validatedVectors: '2',
        dispatchedPreparedBytes: '100',
        validatedPreparedBytes: '100',
        validatedEstimatedInputTokens: '34',
        unknownProviderTokenBatches: '1',
    }),
    expected = {
        children: 2,
        documents: 1,
        preparedBytes: 100,
        estimatedInputTokens: 34,
    };
test('native evidence uses independent additive counters with exact prepared bytes, unknown usage and zero retry/failure', () => {
    const result = nativeDelta(before, after, expected);
    assert.equal(result.validatedNativeVectors, 2);
    assert.equal(result.providerInputTokens, null);
    assert.equal(result.nativeWorkProof.nativeBatches, 1);
    const known = structuredClone(after);
    known.counters.unknownProviderTokenBatches = '0';
    known.counters.knownProviderInputTokens = '17';
    assert.equal(
        nativeDelta(before, known, expected).providerInputTokens,
        '17'
    );
    const empty = nativeDelta(before, before, {
        children: 0,
        documents: 0,
        preparedBytes: 0,
        estimatedInputTokens: 0,
    });
    assert.equal(empty.validatedNativeVectors, 0);
    assert.equal(empty.nativeWorkProof.nativeBatches, 0);
    for (const change of [
        (value) => (value.counters.validatedVectors = '1'),
        (value) => (value.counters.nativeStarts = '2'),
        (value) => (value.counters.recordedFailures = '1'),
        (value) => (value.knownGapReports = '1'),
        (value) => (value.producerIdentitySha256 = 'b'.repeat(64)),
        (value) => (value.counters.validatedPreparedBytes = '99'),
        (value) => (value.counters.validatedEstimatedInputTokens = '33'),
        (value) => (value.hours = []),
    ]) {
        const invalid = structuredClone(after);
        change(invalid);
        assert.throws(() => nativeDelta(before, invalid, expected));
    }
});
test('stable samples wait through real-looking pending counters and reject drift/deadlines without inventing a flush acknowledgement', async () => {
    let time = 0,
        reads = 0;
    const result = await stableNativeSnapshot(
        async () => {
            reads++;
            return reads < 3 ? { ...before, quiescent: false } : before;
        },
        {
            now: () => time,
            sleep: async (ms) => (time += ms),
            verify: async () => {},
        }
    );
    assert.deepEqual(result, before);
    assert(time >= 7000);
    time = 0;
    await assert.rejects(
        () =>
            stableNativeSnapshot(
                async () => ({
                    ...before,
                    counters: {
                        ...before.counters,
                        nativeStarts: String(time),
                    },
                }),
                {
                    now: () => time,
                    sleep: async (ms) => (time += ms),
                    verify: async () => {},
                }
            ),
        { code: 'LOAD_OBS_NOT_DRAINED' }
    );
});
test('receipt is immutable per generation and revalidation never attributes later rollups to old work', async () => {
    let time = 0,
        current = before,
        nativeReads = 0;
    const files = new Map();
    const geometry = {
        generationId: input.generationId,
        quiescent: true,
        physicalChildren: 2,
        parents: 1,
        manifestSha256: 'c'.repeat(64),
        preparedBytes: 100,
        estimatedInputTokens: 34,
    };
    const observer = createLoadObserver({
        state,
        fixture,
        admit: async () => {},
        reader: {
            native: async () => {
                nativeReads++;
                return current;
            },
            generation: async () => geometry,
        },
        store: {
            write: async (name, value) => {
                assert(!files.has(name));
                files.set(name, structuredClone(value));
            },
            read: async (name) => structuredClone(files.get(name)),
        },
        now: () => time,
        sleep: async (ms) => (time += ms),
    });
    const baseline = await observer.beginIndexObservation(input);
    current = after;
    const request = {
        ...roleFields('pilotA'),
        organizationId: 'orgA',
        collectionId: input.collectionId,
        generationId: input.generationId,
        bindings: [{ documentId: uuid(3), versionId: uuid(4) }],
        descriptors: [{}],
        nativeBaseline: baseline,
    };
    const result = await observer.observeGeneration(request);
    assert.equal(result.usage.validatedNativeVectors, 2);
    assert.equal(files.size, 2);
    current = snapshot({ validatedVectors: '999999' });
    const priorReads = nativeReads;
    const replay = await observer.observeGeneration({
        ...request,
        expectedNativeWorkProof: result.usage.nativeWorkProof,
    });
    assert.deepEqual(replay.usage, result.usage);
    assert.equal(nativeReads, priorReads);
    const receipt = [...files.keys()].find((key) => key.startsWith('receipt-'));
    files.get(receipt).expected.children = 3;
    await assert.rejects(
        () =>
            observer.observeGeneration({
                ...request,
                expectedNativeWorkProof: result.usage.nativeWorkProof,
            }),
        { code: 'LOAD_OBS_RECEIPT' }
    );
});
test('scope and disabled real factory refuse before any injected resource/client callback', async () => {
    assert.equal(validateIdentity(state, fixture), run);
    assert.throws(() =>
        validateIdentity(
            { ...state, applicationDatabase: 'production' },
            fixture
        )
    );
    await assert.rejects(
        () => createLoadObservationRuntime({ state: null, fixture: null }),
        {
            code: STATIC_DRAFT_ONLY
                ? 'LOAD_OBS_RUNTIME_DISABLED'
                : 'LOAD_OBS_SCOPE',
        }
    );
});
function layoutFixture(suppliedPlan = null, suppliedDescriptor = null) {
    const plan = suppliedPlan ?? planDocument(1, 3),
        count = plan.rows.length,
        identity = {
            schemaVersion: 1,
            provider: 'OLLAMA',
            model: 'embeddinggemma:latest',
            digest: LOAD_IDENTITY.weights,
            contextTokens: 8192,
            preset: 'EMBEDDING_GEMMA',
            dimensions: 768,
        };
    const mediaType = suppliedDescriptor?.mediaType ?? 'text/plain',
        extractorVersion =
            mediaType === 'application/pdf'
                ? 'pdf-structured-v1'
                : mediaType ===
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                  ? 'docx-structured-v1'
                  : 'utf8-text-v1';
    const candidate = {
        id: uuid(4),
        organizationId: 'orgA',
        generationId: input.generationId,
        documentId: uuid(3),
        sourceVersionId: uuid(5),
        fileName: plan.spec.filename,
        mediaType,
        sha256: sha(plan.bytes),
        version: 1,
        extractorVersion,
        status: 'PUBLISHED',
        sourceStatus: 'READY',
        sourceState: 'AVAILABLE',
        extractionDiscardedAt: null,
        discardedAt: null,
        publishedAt: new Date(),
        vectorSealedAt: new Date(),
        chunkCount: count,
        materializedChunks: count,
        holdState: 'LIVE',
        metadataRevision: 1,
        desiredMetadataRevision: 1,
        candidateBuildRevision: 1,
        buildRevision: 1,
        desiredVersionId: uuid(5),
        extractionId: uuid(6),
        desiredExtractionId: uuid(6),
        removedAt: null,
    };
    const rows = [...plan.rows, ...plan.parents.parents].map((row, index) => ({
        id: uuid(10 + index),
        organizationId: 'orgA',
        generationId: input.generationId,
        indexedDocumentId: candidate.id,
        ordinal: index,
        kind: index < count ? 'CHILD' : 'PARENT',
        text: row.text,
        textHash: sha(row.text),
        embeddingInputHash:
            index < count
                ? sha(
                      prepareEmbeddingInput(identity, 'document', row.text, {
                          title: candidate.fileName,
                          preparation: '',
                      })
                  )
                : null,
        startOffset: row.start,
        endOffset: row.end,
        parentId:
            index < count
                ? uuid(10 + plan.parents.childParentOrdinals[index])
                : null,
        sourceSpans: row.sourceSpans,
        sourceSpanCount: row.sourceSpans.length,
        tokenCount: row.tokenCount,
        tokenCountIsEstimate: true,
    }));
    candidate.manifestHash = manifestHash(
        rows.slice(0, count).map((row) => ({
            chunkId: row.id,
            ordinal: row.ordinal,
            chunkHash: row.textHash,
        }))
    );
    const physical = rows.slice(0, count).map((row) => ({
        chunk_id: row.id,
        publication_id: candidate.id,
        source_version_id: candidate.sourceVersionId,
        document_id: candidate.documentId,
        generation_id: candidate.generationId,
        ordinal: row.ordinal,
        chunk_hash: row.textHash,
        dimensions: 768,
        finite_nonzero: true,
    }));
    return {
        candidate,
        descriptor: {
            originalSha256: candidate.sha256,
            canonicalSha256: sha(plan.text),
            fileName: candidate.fileName,
            mediaType,
        },
        artifact: plan.artifact,
        children: plan.rows,
        parents: plan.parents.parents,
        mapping: plan.parents.childParentOrdinals,
        rows,
        physical,
        ledger: {
            state: 'SEALED',
            document_id: candidate.documentId,
            source_version_id: candidate.sourceVersionId,
            expected_count: count,
            manifest_hash: candidate.manifestHash,
        },
        identity,
        prepare: prepareEmbeddingInput,
        manifestHash,
    };
}
test('real planner geometry validates parent links, every native input hash and physical provenance without loading vector values', () => {
    const fixture = layoutFixture(),
        result = validateDocumentLayout(fixture);
    assert.equal(result.childCount, 3);
    assert.equal(result.parentCount, 1);
    assert(result.preparedBytes > 0);
    assert.equal(
        result.estimatedInputTokens,
        fixture.children.reduce(
            (total, row) =>
                total +
                Math.ceil(
                    Buffer.byteLength(
                        prepareEmbeddingInput(
                            fixture.identity,
                            'document',
                            row.text,
                            {
                                title: fixture.candidate.fileName,
                                preparation: '',
                            }
                        )
                    ) / 4
                ),
            0
        )
    );
    for (const change of [
        (value) => (value.rows[0].text += 'changed'),
        (value) => (value.rows[0].embeddingInputHash = '0'.repeat(64)),
        (value) => (value.rows[0].sourceSpans = []),
        (value) => (value.rows[0].parentId = null),
        (value) => (value.physical[0].document_id = 'foreign'),
        (value) => (value.physical[0].source_version_id = uuid(99)),
        (value) => (value.physical[0].ordinal = 2),
        (value) => (value.physical[0].finite_nonzero = false),
        (value) => (value.ledger.expected_count = 2),
        (value) => (value.candidate.holdState = 'RETIRED'),
    ]) {
        const { prepare, manifestHash: manifest, ...data } = fixture,
            changed = {
                ...structuredClone(data),
                prepare,
                manifestHash: manifest,
            };
        change(changed);
        assert.throws(() => validateDocumentLayout(changed));
    }
});
test('all four frozen reference formats preserve actual canonical source geometry and exact extractor selection', () => {
    const base = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            '../quality/reference-v1'
        ),
        manifest = JSON.parse(
            fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')
        );
    for (const format of ['TEXT', 'MARKDOWN', 'PDF', 'DOCX']) {
        const descriptor = manifest.documents.find(
                (doc) => doc.extractionFormat === format
            ),
            artifact = JSON.parse(
                fs.readFileSync(
                    path.join(base, descriptor.canonicalPath),
                    'utf8'
                )
            ),
            bytes = fs.readFileSync(path.join(base, descriptor.originalPath));
        assert.equal(sha(bytes), descriptor.originalSha256);
        assert.equal(sha(artifact.text), descriptor.canonicalSha256);
        const rows = [
                ...resolveChunkingStrategy(
                    'TOKEN_WINDOW',
                    'token-window-utf8-v1'
                ).plan(artifact, {
                    targetTokens: 512,
                    minTokens: 128,
                    maxTokens: 768,
                    overlapTokens: 64,
                    maxEmbeddingInputBytes: 6144,
                    maxChunks: 500,
                }),
            ],
            parents = planParentContext(artifact, rows, {
                parentMaxTokens: 2048,
            });
        const fixture = layoutFixture(
            {
                rows,
                parents,
                artifact,
                text: artifact.text,
                bytes,
                spec: { filename: descriptor.fileName },
            },
            descriptor
        );
        assert.equal(validateDocumentLayout(fixture).childCount, rows.length);
        fixture.candidate.extractorVersion = 'wrong-version';
        assert.throws(() => validateDocumentLayout(fixture), {
            code: 'LOAD_OBS_SOURCE',
        });
    }
});
function mockSQL(database, respond) {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.startsWith('SELECT current_database'))
                return { rows: [{ database, readonly: 'on' }] };
            if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/u.test(sql))
                return { rows: [] };
            return { rows: await respond(sql, params) };
        },
    };
}
test('native SQL is one read-only repeatable-read transaction with closed counters and tenant predicates', async () => {
    const client = mockSQL(state.applicationDatabase, async (sql) =>
        sql.includes('FROM "RagOperationalHour"')
            ? [
                  {
                      count: 1,
                      hours: [new Date('2026-10-23T00:00:00.000Z')],
                      ...before.counters,
                  },
              ]
            : sql.includes('OrganizationRagTelemetry')
              ? [{ formatVersion: 1, knownGapReports: '0' }]
              : [{ count: 0 }]
    );
    const result = await readNativeSnapshot(client, {
        state,
        input,
        producerIdentitySha256: 'a'.repeat(64),
    });
    assert.deepEqual(result, before);
    assert.equal(
        client.calls[0].sql,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    assert(client.calls.some((call) => call.sql === 'COMMIT'));
    assert(
        client.calls
            .filter((call) => call.params)
            .every((call) => call.params[0] === 'orgA')
    );
    assert(
        !client.calls.some((call) =>
            /\b(INSERT|UPDATE|DELETE)\b/u.test(call.sql)
        )
    );
    const bad = mockSQL('wrong_test', async () => []);
    await assert.rejects(
        () =>
            readNativeSnapshot(bad, {
                state,
                input,
                producerIdentitySha256: 'a'.repeat(64),
            }),
        { code: 'LOAD_OBS_DATABASE' }
    );
    assert.equal(bad.calls.at(-1).sql, 'ROLLBACK');
});
test('real SQL reader checks small mocked app+vector snapshots, bounded JSON projection and rollback on tuple tamper', async () => {
    const layout = layoutFixture(),
        profile = loadProfile(),
        vxId = uuid(90),
        url = new URL(state.environment.VECTOR_DATABASE_URL),
        fingerprint = sha(
            JSON.stringify([
                url.hostname,
                url.port,
                decodeURI(url.pathname.slice(1)),
                'vector_collections',
                'disable',
                'postgres',
                'false',
                false,
            ]) +
                ':' +
                vxId
        );
    const generation = {
        ...profile,
        id: input.generationId,
        organizationId: 'orgA',
        collectionId: input.collectionId,
        status: 'ACTIVE',
        activeGenerationId: input.generationId,
        deletedAt: null,
        configurationRevision: 1,
        modelIdentity: LOAD_IDENTITY.weights,
        chunkerVersion: 'token-window-utf8-v1',
        parentContextVersion: 'parent-context-utf8-v1',
        endpoint: state.environment.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
        vectorSchema: 'vector_collections',
        tableName: generationTable(input.generationId),
        destinationFingerprint: fingerprint,
        appliedSequence: '1',
        contentSequence: '1',
        identity: layout.identity,
        projectedChunks: '3',
        activeChunks: '3',
        retainedChunks: '0',
        reservedChunks: '0',
    };
    const app = mockSQL(state.applicationDatabase, async (sql, p) =>
        sql.includes('FROM "IndexGeneration"')
            ? [generation]
            : sql.includes('FILTER(WHERE "publishedIndexedDocumentId"')
              ? [{ count: 1, published: 1 }]
              : sql.includes('FROM "IndexTask"')
                ? [{ count: 1, bad: 0 }]
                : sql.includes('FROM "GenerationDocument" d')
                  ? [layout.candidate]
                  : sql.includes('FROM "Chunk"')
                    ? p[3] === -1
                        ? layout.rows
                        : []
                    : assert.fail('unexpected app query')
    );
    const vx = mockSQL(state.vectorDatabase, async (sql, p) =>
        sql.includes('vx_identity')
            ? [{ identity: vxId, version: 1 }]
            : sql.includes('vx_generations')
              ? [
                    {
                        organization_id: 'orgA',
                        collection_id: input.collectionId,
                        destination_fingerprint: fingerprint,
                        shape: {
                            dimensions: 768,
                            metric: 'cosine',
                            indexType: 'DISKANN',
                            numericType: 'float32',
                        },
                        state: 'READY',
                    },
                ]
              : sql.includes('count(*)')
                ? [{ count: 3 }]
                : sql.includes('vx_publications')
                  ? [layout.ledger]
                  : sql.includes('SELECT chunk_id')
                    ? p[1] === -1
                        ? layout.physical
                        : []
                    : assert.fail('unexpected vector query')
    );
    const dependencies = {
        profile: () => structuredClone(profile),
        identity: (value) => value,
        generationTable,
        manifestHash,
        prepare: prepareEmbeddingInput,
        canonical: async () => layout.artifact,
        plan: () => ({
            children: layout.children,
            parents: layout.parents,
            mapping: layout.mapping,
        }),
    };
    const proof = await readGenerationProof(app, vx, {
        state,
        input: {
            ...input,
            bindings: [
                {
                    documentId: layout.candidate.documentId,
                    versionId: layout.candidate.sourceVersionId,
                },
            ],
            descriptors: [layout.descriptor],
        },
        dependencies,
    });
    assert.equal(proof.physicalChildren, 3);
    assert(proof.allPhysicalManifestRowsVerified);
    assert(
        app.calls.some(
            (call) =>
                call.sql.includes('LIMIT 64') && call.sql.includes('LIMIT 500')
        )
    );
    assert(vx.calls.some((call) => call.sql === 'COMMIT'));
    layout.physical[0].document_id = 'foreign';
    await assert.rejects(
        () =>
            readGenerationProof(app, vx, {
                state,
                input: {
                    ...input,
                    bindings: [
                        {
                            documentId: layout.candidate.documentId,
                            versionId: layout.candidate.sourceVersionId,
                        },
                    ],
                    descriptors: [layout.descriptor],
                },
                dependencies,
            }),
        { code: 'LOAD_OBS_PHYSICAL_ROW' }
    );
    assert.equal(app.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(vx.calls.at(-1).sql, 'ROLLBACK');
    let time = 0;
    const prior = app.calls.length;
    await assert.rejects(
        () =>
            readGenerationProof(app, vx, {
                state,
                input: { ...input, bindings: [], descriptors: [] },
                dependencies: {
                    ...dependencies,
                    now: () => {
                        const value = time;
                        time += 300001;
                        return value;
                    },
                },
            }),
        { code: 'LOAD_OBS_READ_DEADLINE' }
    );
    assert(
        !app.calls
            .slice(prior)
            .some((call) => call.sql.includes('FROM "IndexGeneration"'))
    );
    let canonicalClock = 0;
    const beforeCanonical = app.calls.length;
    await assert.rejects(
        () =>
            readGenerationProof(app, vx, {
                state,
                input: {
                    ...input,
                    bindings: [
                        {
                            documentId: layout.candidate.documentId,
                            versionId: layout.candidate.sourceVersionId,
                        },
                    ],
                    descriptors: [layout.descriptor],
                },
                dependencies: {
                    ...dependencies,
                    now: () => canonicalClock,
                    canonical: async () => {
                        canonicalClock = 300001;
                        return layout.artifact;
                    },
                },
            }),
        { code: 'LOAD_OBS_READ_DEADLINE' }
    );
    assert(
        !app.calls
            .slice(beforeCanonical)
            .some((call) => call.sql.includes('FROM "Chunk"'))
    );
});
