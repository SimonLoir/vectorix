/** Local synthetic metadata, clocks, process protocols and owned temporary files only. No worker/process/socket/model is started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
    eligible,
    validateTrafficResult,
    trafficRequest,
    createLexicalControls,
    lexicalPositiveControl,
} from './load-traffic-oracle.mjs';
import { readTrafficCatalog } from './load-traffic-catalog.mjs';
import { followTrafficSources } from './load-traffic-sources.mjs';
import { verifyTrafficServingState } from './load-traffic-inventory.mjs';
import {
    trafficGuardCore,
    createTrafficGuard,
} from './load-traffic-async-guard.mjs';
import { checkedWorkerSummary } from './load-traffic-resource-worker.mjs';
import { trafficWorkerMeasurements } from './load-traffic-resources.mjs';
import {
    validateTrafficContext,
    validateTrafficFullReport,
    createTrafficRunFiles,
    createLoadTrafficContext,
    waitTrafficAuthCooldown,
} from './load-traffic-composition.mjs';
import {
    executeLoadTrafficWorkflow,
    TRAFFIC_RUNTIME_HELPERS,
} from './load-traffic-runtime.mjs';
import {
    LOAD_RUNTIME_HELPERS,
    summaryFor,
} from './load-import-runtime-policy.mjs';
import { LOAD_IDENTITY, loadResourcePolicyHash } from './load-import-core.mjs';
import { sha, digest } from './load-observer-core.mjs';
const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../..'
    ),
    run = '0123456789ab',
    prefix = 'vectorix-m7c-load-' + run;
const fixture = {
    schemaVersion: 1,
    namespace: 'vectorix-m7c-load',
    runId: run,
    organizationIds: ['orgA', 'orgB'],
    users: Object.fromEntries(
        ['owner', 'reader', 'foreign'].map((role) => [
            role,
            {
                userId: role,
                memberId: role + 'Member',
                organizationId: role === 'foreign' ? 'orgB' : 'orgA',
                email: `m7c-load-${role}-${run}@example.test`,
                password: 'synthetic-password-not-real',
            },
        ])
    ),
};
const state = {
    schemaVersion: 1,
    namespace: fixture.namespace,
    runId: run,
    prefix,
    applicationDatabase: `vectorix_m7c_load_app_${run}_test`,
    vectorDatabase: `vectorix_m7c_load_vectors_${run}_test`,
    commit: 'c'.repeat(40),
    images: { synthetic: 'image' },
    resourceLimits: { synthetic: 1 },
    loadPolicy: {
        model: { digest: LOAD_IDENTITY.weights },
        minimumFreeBytes: 4 * 1024 ** 3,
    },
    ports: { postgres: 15432, vector: 15433, api: 18001, web: 18002 },
    apiOrigin: 'http://127.0.0.1:18001',
    webOrigin: 'http://127.0.0.1:18002',
    environment: {
        DATABASE_URL: `postgresql://test:test@127.0.0.1:15432/vectorix_m7c_load_app_${run}_test`,
        VECTOR_DATABASE_URL: `postgresql://test:test@127.0.0.1:15433/vectorix_m7c_load_vectors_${run}_test`,
        BETTER_AUTH_URL: 'http://127.0.0.1:18001',
        API_URL: 'http://127.0.0.1:18001',
        VECTORIX_WEB_URL: 'http://127.0.0.1:18002',
        TRUSTED_ORIGINS: 'http://127.0.0.1:18002',
    },
};
test('auth cooldown completes eleven real seconds after a fractional timer early wake before the next one-shot signin', async () => {
    let clock = 123,
        signins = 0;
    const waits = [],
        advances = [0, 10999999, 0, 1];
    await waitTrafficAuthCooldown({
        lastAuthFinished: clock,
        now: () => clock,
        sleep: async (micros) => {
            waits.push(micros);
            clock += advances.shift();
        },
        assertSafe() {},
    });
    signins++;
    assert.deepEqual(waits, [11000000, 11000000, 1000, 1000]);
    assert(clock - 123 >= 11000000);
    assert.equal(signins, 1);
    await waitTrafficAuthCooldown({
        lastAuthFinished: null,
        now: () => assert.fail('first auth has no cooldown clock'),
        sleep: () => assert.fail('first auth must not sleep'),
        assertSafe() {},
    });
});
test('cooldown refuses stalled or backwards clocks and newly unsafe state before another authentication attempt', async () => {
    for (const [unsafe, backwards] of [
        [false, false],
        [false, true],
        [true, false],
    ]) {
        let clock = 123,
            waited = false,
            signins = 0,
            sleeps = 0;
        await assert.rejects(async () => {
            await waitTrafficAuthCooldown({
                lastAuthFinished: 123,
                now: () => clock,
                sleep: async () => {
                    waited = true;
                    sleeps++;
                    if (backwards) clock--;
                    if (unsafe) clock++;
                },
                assertSafe() {
                    if (unsafe && waited) throw Error('SYNTHETIC_UNSAFE');
                },
            });
            signins++;
        });
        assert.equal(waited, true);
        assert.equal(signins, 0);
        assert.equal(sleeps, unsafe || backwards ? 1 : 64);
    }
});
const statePath = path.join(
    root,
    'node_modules/.cache/vectorix',
    prefix,
    'state.json'
);
const catalogDocument = {
    documentId: 'doc',
    publicationId: 'pub',
    versionId: 'version',
    fileName: 'synthetic.txt',
    mediaType: 'text/plain',
    language: 'FR',
    tags: ['synthetic'],
    metadata: { year: 2026, active: true, date: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
};
function oracleFixture() {
    const text = 'Café cafe\u0301 🧭. Retour reçu.',
        source = { index: 0, kind: 'TEXT', start: 0, end: text.length },
        spans = [{ source, start: 0, end: text.length }],
        parent = {
            id: 'parent',
            kind: 'PARENT',
            ordinal: 1,
            parentId: null,
            startOffset: 0,
            endOffset: text.length,
            textHash: sha(text),
            sourceSpans: spans,
            tokenCount: 12,
        },
        child = {
            ...parent,
            id: 'child',
            kind: 'CHILD',
            ordinal: 0,
            parentId: 'parent',
            embeddingInputHash: 'a'.repeat(64),
        },
        doc = {
            ...catalogDocument,
            artifact: { text, sources: [source] },
            chunks: new Map([
                ['child', child],
                ['parent', parent],
            ]),
            originalBytes: Buffer.byteLength(text),
            originalSha256: sha(text),
        },
        reports = { A: { generationId: 'gen', collectionId: 'col' } };
    const request = () => ({
            collectionId: 'col',
            query: 'synthetic',
            topK: 10,
            strategy: 'HYBRID',
            filters: {
                languages: ['FR'],
                metadata: [{ field: 'active', operator: 'EQ', value: true }],
            },
        }),
        offer = { organization: 'A', mode: 'HYBRID', selectiveFilter: false };
    const row = {
        id: 'child',
        generationId: 'gen',
        publicationId: 'pub',
        documentId: 'doc',
        documentName: doc.fileName,
        version: 1,
        ordinal: 0,
        published: true,
        text,
        tokenCount: 12,
        tokenCountIsEstimate: true,
        language: 'FR',
        tags: doc.tags,
        metadata: doc.metadata,
        mediaType: 'text/plain',
        sourceSpans: spans,
        sourceSpansTruncated: false,
        startOffset: 0,
        endOffset: text.length,
        parentContext: {
            ...parent,
            text,
            tokenCountIsEstimate: true,
            sourceSpansTruncated: false,
        },
        scores: {
            rrf: 0.1,
            lexicalRank: 1,
            vectorRank: 1,
            vectorDistance: 0.2,
        },
        source: {
            receipt: 'synthetic-private-receipt',
            expiresAt: '2026-10-23T00:15:00.000Z',
        },
    };
    return {
        text,
        doc,
        offer,
        input: {
            request,
            maps: { A: new Map([['doc', doc]]) },
            reports,
            types: { A: { active: 'BOOLEAN', year: 'NUMBER', date: 'DATE' } },
        },
        value: {
            generationId: 'gen',
            model: 'embeddinggemma:latest',
            strategy: 'HYBRID',
            vectorUnderfilled: false,
            parentUnderfilled: false,
            results: [row],
        },
    };
}
test('preloaded typed filter and exact canonical child/parent oracle reject altered source, version, ranges, parents, metadata and scores', () => {
    const f = oracleFixture();
    const result = validateTrafficResult(f.offer, f.value, f.input);
    assert.equal(result.safe.results, 1);
    assert(!JSON.stringify(result.safe).includes('receipt'));
    assert(
        eligible(
            f.doc,
            {
                metadata: [
                    { field: 'year', operator: 'GTE', value: 2025 },
                    {
                        field: 'date',
                        operator: 'LTE',
                        value: '2027-01-01T00:00:00.000Z',
                    },
                ],
            },
            f.input.types.A
        )
    );
    assert(
        !eligible(
            f.doc,
            { metadata: [{ field: 'year', operator: 'LTE', value: 2025 }] },
            f.input.types.A
        )
    );
    assert.throws(() =>
        eligible(f.doc, { documentFixtureIds: ['unknown'] }, f.input.types.A)
    );
    for (const change of [
        (v) => (v.generationId = 'wrong'),
        (v) => (v.results[0].version = 2),
        (v) => (v.results[0].text += 'x'),
        (v) => (v.results[0].startOffset = 1),
        (v) => (v.results[0].parentContext.id = 'foreign'),
        (v) => (v.results[0].parentContext.sourceSpans = []),
        (v) => (v.results[0].metadata.active = false),
        (v) => (v.results[0].scores.vectorDistance = null),
        (v) => v.results.push(structuredClone(v.results[0])),
    ]) {
        const invalid = structuredClone(f.value);
        change(invalid);
        assert.throws(() => validateTrafficResult(f.offer, invalid, f.input));
    }
});
test('legitimate zero-hit lexical/native results remain successful while malformed identity is rejected and primary unfiltered eligibility is truly100k', () => {
    const f = oracleFixture(),
        input = {
            ...f.input,
            maps: { B: f.input.maps.A },
            reports: { B: f.input.reports.A },
            types: { B: f.input.types.A },
        };
    for (const mode of ['LEXICAL', 'VECTOR', 'HYBRID']) {
        const value = { ...f.value, strategy: mode, results: [] },
            proof = validateTrafficResult(
                { organization: 'B', mode, queryOrdinal: 3 },
                value,
                input
            );
        assert.equal(proof.safe.results, 0);
        assert.equal(proof.source, null);
        assert.throws(() =>
            validateTrafficResult(
                { organization: 'B', mode },
                { ...value, generationId: 'foreign' },
                input
            )
        );
    }
    const docs = new Map(
            ['EN', 'FR'].map((language) => [
                language,
                { ...f.doc, documentId: language, language, childCount: 50000 },
            ])
        ),
        context = {
            maps: { A: docs },
            reports: { A: { collectionId: 'primary', generationId: 'gen' } },
            types: { A: { active: 'BOOLEAN' } },
            references: { queries: [] },
        },
        offer = {
            organization: 'A',
            language: 'FR',
            mode: 'VECTOR',
            queryOrdinal: 1,
            selectiveFilter: false,
        };
    const request = trafficRequest(offer, context);
    assert.deepEqual(request.filters, {});
    const proof = validateTrafficResult(
        offer,
        { ...f.value, strategy: 'VECTOR', results: [] },
        { ...context, request: (value) => trafficRequest(value, context) }
    );
    assert.equal(proof.safe.eligibleChildren, 100000);
    assert.equal(proof.safe.eligibleDocuments, 2);
    assert(proof.safe.unfiltered);
    const selective = trafficRequest(
        { ...offer, selectiveFilter: true },
        context
    );
    assert.deepEqual(selective.filters.documentIds, ['FR']);
    assert.deepEqual(selective.filters.languages, ['FR']);
});
test('frozen lexical EXACT controls require a same-language eligible gold span in a canonical child; excluded controls and native modes have no recall gate', () => {
    const f = oracleFixture(),
        FR = { ...f.doc, fixtureId: 'fr' },
        EN = { ...f.doc, documentId: 'docEN', fixtureId: 'en', language: 'EN' },
        map = new Map([
            ['doc', FR],
            ['docEN', EN],
        ]),
        queries = Array.from({ length: 40 }, (_, i) => ({
            id: 'Q' + i,
            category: i < 10 ? 'EXACT' : 'PARAPHRASE',
            language: i % 2 ? 'FR' : 'EN',
        })),
        qrels = queries.map((query) => ({
            queryId: query.id,
            editions: [EN, FR].map((doc) => ({
                fixtureId: doc.fixtureId,
                version: 1,
                canonicalSha256: sha(f.text),
                spans: [
                    {
                        startOffset: 0,
                        endOffset: 4,
                        textSha256: sha(f.text.slice(0, 4)),
                    },
                ],
            })),
        })),
        controls = createLexicalControls({ queries, qrels }, map),
        options = { controls, map, types: f.input.types.A },
        offer = { organization: 'B', mode: 'LEXICAL', queryOrdinal: 1 };
    assert.equal(controls.size, 10);
    assert.deepEqual(
        lexicalPositiveControl(offer, {}, f.value.results, options),
        { eligible: true, hit: true }
    );
    assert.deepEqual(lexicalPositiveControl(offer, {}, [], options), {
        eligible: true,
        hit: false,
    });
    assert.deepEqual(
        lexicalPositiveControl(offer, { documentIds: ['docEN'] }, [], options),
        { eligible: false, hit: null }
    );
    assert.deepEqual(
        lexicalPositiveControl({ ...offer, mode: 'VECTOR' }, {}, [], options),
        { eligible: false, hit: null }
    );
    const wrong = new Map(map);
    wrong.set('doc', {
        ...FR,
        chunks: new Map(
            [...FR.chunks].map(([key, row]) => [
                key,
                row.kind === 'CHILD' ? { ...row, startOffset: 5 } : row,
            ])
        ),
    });
    assert.throws(
        () => createLexicalControls({ queries, qrels }, wrong),
        /CONTROL_CHILD/u
    );
});
test('catalog preload uses readonly bounded per-document pages and exact current source bindings', async () => {
    const sqls = [],
        chunks = [
            {
                id: 'child',
                ordinal: 0,
                kind: 'CHILD',
                parentId: 'parent',
                startOffset: 0,
                endOffset: 10,
                textHash: 'a'.repeat(64),
                embeddingInputHash: 'b'.repeat(64),
            },
            {
                id: 'parent',
                ordinal: 1,
                kind: 'PARENT',
                parentId: null,
                startOffset: 0,
                endOffset: 10,
                textHash: 'a'.repeat(64),
                embeddingInputHash: null,
            },
        ];
    const client = {
        async query(sql, args) {
            sqls.push({ sql, args });
            if (sql.startsWith('SELECT current_database'))
                return {
                    rows: [
                        { database: state.applicationDatabase, readonly: 'on' },
                    ],
                };
            if (sql.includes('FROM "IndexGeneration"'))
                return {
                    rows: [
                        {
                            id: 'gen',
                            identity: {
                                provider: 'OLLAMA',
                                digest: LOAD_IDENTITY.weights,
                                dimensions: 768,
                            },
                        },
                    ],
                };
            if (sql.includes('FROM "GenerationDocument"'))
                return { rows: [structuredClone(catalogDocument)] };
            if (sql.includes('FROM "Chunk"')) return { rows: chunks };
            return { rows: [] };
        },
    };
    const result = await readTrafficCatalog(client, {
        state,
        fixture,
        input: {
            organizationId: 'orgA',
            collectionId: 'col',
            generationId: 'gen',
            bindings: [{ documentId: 'doc', versionId: 'version' }],
        },
        parseIdentity: (value) => value,
    });
    assert.equal(result.documents[0].chunks.length, 2);
    assert(sqls[0].sql.endsWith('READ ONLY'));
    assert(sqls.some((row) => row.sql.includes('LIMIT 500')));
    assert(!sqls.some((row) => /\b(INSERT|UPDATE|DELETE)\b/u.test(row.sql)));
    await assert.rejects(() =>
        readTrafficCatalog(client, {
            state,
            fixture,
            input: {
                organizationId: 'orgA',
                collectionId: 'col',
                generationId: 'gen',
                bindings: [{ documentId: 'doc', versionId: 'foreign-version' }],
            },
            parseIdentity: (value) => value,
        })
    );
});
test('source follower independently verifies surrogate-safe preview and complete original SHA without a search or receipt in safe output', async () => {
    const text = 'x'.repeat(19999) + '🧭tail',
        source = { index: 0, kind: 'TEXT', start: 0, end: text.length },
        doc = {
            fileName: 'synthetic.txt',
            artifact: { text, sources: [source] },
            originalBytes: Buffer.byteLength(text),
            originalSha256: sha(text),
        },
        calls = [];
    const api = {
        async call(_role, operation) {
            calls.push(operation);
            return {
                value:
                    operation === 'indexing.sourcePreview'
                        ? {
                              version: 1,
                              source,
                              documentName: doc.fileName,
                              totalCharacters: text.length,
                              text: text.slice(0, 19999),
                              nextOffset: 19999,
                          }
                        : new File([text], doc.fileName, {
                              type: 'text/plain',
                          }),
            };
        },
    };
    const request = {
        sources: [
            {
                organization: 'A',
                documentId: 'doc',
                version: 1,
                source,
                receipt: 'synthetic-private',
                collectionId: 'col',
            },
        ],
        oracle: { sourceDocument: () => doc },
        api,
        check() {},
    };
    const result = await followTrafficSources(request);
    assert(result[0].verified);
    assert.deepEqual(calls, [
        'indexing.sourcePreview',
        'indexing.sourceOriginal',
    ]);
    assert(!JSON.stringify(result).includes('synthetic-private'));
    await assert.rejects(() =>
        followTrafficSources({
            ...request,
            api: {
                call: async () => ({
                    value: new File(['wrong'], doc.fileName),
                }),
            },
        })
    );
});
test('growing library inventory admits only declared tiny IDs while immutable collections reuse their saved native receipt', async () => {
    const bindings = (n) =>
            Array.from({ length: n }, (_, i) => ({
                fixtureId: 'fixture' + i,
                documentId: 'doc' + n + '-' + i,
                versionId: 'version' + n + '-' + i,
            })),
        load = bindings(200),
        reference = bindings(24),
        ingestion = {
            A: [
                { binding: { documentId: 'tinyA', versionId: 'tinyVersionA' } },
            ],
            B: [
                { binding: { documentId: 'tinyB', versionId: 'tinyVersionB' } },
            ],
        },
        collection = (name, n) => ({
            collectionId: name,
            generationId: name + 'gen',
            activeChildren: n,
            parents: 1,
            profile: { provider: 'OLLAMA' },
            nativeBaseline: { baselineSha256: 'a'.repeat(64) },
            observation: {
                manifestSha256: 'b'.repeat(64),
                nativeWorkProof: { receiptSha256: 'c'.repeat(64) },
            },
        }),
        primary = collection('primary', 100000),
        ref = collection('reference', 24),
        fullReport = {
            documents: { loadA: load },
            collections: { primary, pilot: { collectionId: 'pilot' } },
            baseline: {
                documents: { referenceB: reference },
                collections: {
                    referenceB: ref,
                    ingestionA: { collectionId: 'ia' },
                    ingestionB: { collectionId: 'ib' },
                },
            },
        },
        seen = [];
    const api = {
        async call(role, op, input) {
            const A = role === 'owner',
                saved = A ? primary : ref;
            if (op.endsWith('.list')) {
                const ids =
                    op === 'documents.list'
                        ? [
                              ...(A ? load : reference).map(
                                  (row) => row.documentId
                              ),
                              A ? 'tinyA' : 'tinyB',
                          ]
                        : A
                          ? ['primary', 'pilot', 'ia']
                          : ['reference', 'ib'];
                return {
                    value: {
                        total: ids.length,
                        items: ids
                            .slice(input.offset, input.offset + input.limit)
                            .map((id) => ({ id })),
                    },
                };
            }
            if (op === 'collections.get')
                return {
                    value: {
                        configurationRevision: 1,
                        permissions: {
                            read: true,
                            manageDocuments: true,
                            administer: true,
                        },
                        configuration: saved.profile,
                    },
                };
            return {
                value: {
                    active: {
                        id: saved.generationId,
                        status: 'ACTIVE',
                        projectedChunks: saved.activeChildren,
                    },
                    usage: { reservedChunks: 0, retainedChunks: 0 },
                },
            };
        },
    };
    const observer = {
        async observeGeneration(input) {
            seen.push(input);
            const saved = input.collectionId === 'primary' ? primary : ref;
            return {
                physicalChildren: saved.activeChildren,
                parents: 1,
                manifestSha256: 'b'.repeat(64),
                usage: { nativeWorkProof: saved.observation.nativeWorkProof },
            };
        },
    };
    const options = {
        api,
        observer,
        fullReport,
        fixture,
        ingestion,
        content: {
            manifest: {
                documents: Array.from({ length: 200 }, (_, i) => ({
                    id: 'fixture' + i,
                    filename: 'file' + i,
                    language: 'EN',
                })),
            },
            references: { manifest: { documents: [] } },
        },
    };
    assert(await verifyTrafficServingState(options));
    assert.equal(seen.length, 2);
    assert(
        seen.every(
            (row) =>
                row.expectedNativeWorkProof.receiptSha256 === 'c'.repeat(64)
        )
    );
    assert.deepEqual(
        seen.map((row) => row.organizationId),
        ['orgA', 'orgB']
    );
    await assert.rejects(() =>
        verifyTrafficServingState({ ...options, ingestion: { A: [], B: [] } })
    );
});
test('async guard decodes only finite exact proof, records wall time, and ignores arbitrary child failures', async () => {
    let clock = 0;
    const proof = {
            schemaVersion: 1,
            namespace: state.namespace,
            runId: run,
            purpose: 'import',
            resourceOwnership: true,
            databaseReadOnly: true,
            bootstrapFreshness: false,
        },
        guard = trafficGuardCore({
            state,
            statePath,
            clock: () => clock,
            execute: async () => {
                clock += 123;
                return proof;
            },
        });
    await guard.admit();
    assert.equal(guard.summary().maximumMicros, 123);
    for (const execute of [
        async () => ({ ...proof, secret: 'private' }),
        async () => ({ ...proof, runId: 'other' }),
        async () => {
            throw new Error('postgres://private-token');
        },
    ]) {
        const rejected = trafficGuardCore({ state, statePath, execute });
        await assert.rejects(
            () => rejected.admit(),
            (error) => error.message === 'LOAD_OBS_GUARD'
        );
    }
    assert.throws(
        () =>
            createTrafficGuard({
                state,
                statePath: '/synthetic-invalid/state.json',
            }),
        /LOAD_OBS_(?:RUNTIME_DISABLED|GUARD)/u
    );
});
const workerSummary = () => ({
    schemaVersion: 1,
    kind: 'INDEPENDENT_RESOURCE_SAMPLES',
    evidenceKind: 'LIVE_READ_ONLY',
    runId: run,
    phase: 'full',
    collectionId: 'primary',
    samples: 2,
    durationMs: 180000,
    minimumFreeBytes: 4 * 1024 ** 3,
    peakMemoryBytes: 1024,
    modelWarmState: 'UNKNOWN',
    resourcePolicySha256: loadResourcePolicyHash(state),
    oom: false,
    processLost: false,
    safetyReserveBreached: false,
    observedCPUMicros: 100,
    maximumSampleGapMs: 1000,
    samplesSha256: 'a'.repeat(64),
    memoryDefinition:
        'SUM_PROCESS_RSS_PLUS_CONTAINER_CGROUP_CURRENT_INCLUDES_CACHE_AND_SHARED_PAGES',
    peakDefinition: 'MAX_RECORDED_POINTS_NOT_CONTINUOUS_PEAK',
});
const workerHarness = () => ({
    ...Object.fromEntries(
        [
            'calibrationGuardMicros',
            'factorySetupMicros',
            'firstSampleAndAdmissionMicros',
            'finishMicros',
            'progressReads',
            'progressTotalMicros',
            'progressMaximumMicros',
            'explicitGuards',
            'explicitGuardTotalMicros',
            'explicitGuardMaximumMicros',
        ].map((key) => [key, 1])
    ),
    definition:
        'MEASURED_THREAD_ADMISSION_AND_PROGRESS_COMPONENTS_NOT_EVERY_INTERNAL_SAMPLE_COMPONENT',
});
test('sampler thread protocol preserves exact numeric observations and rejects unsafe/raw channel additions without starting a real thread', async () => {
    let unsafe = false,
        saved = null;
    const fake = () => {
        const worker = new EventEmitter();
        worker.unref = () => {};
        worker.postMessage = (message) =>
            queueMicrotask(() =>
                worker.emit(
                    'message',
                    message.type === 'START'
                        ? { type: 'STARTED' }
                        : {
                              type: 'FINISHED',
                              summary: workerSummary(),
                              harness: workerHarness(),
                          }
                )
            );
        queueMicrotask(() => worker.emit('message', { type: 'READY' }));
        return worker;
    };
    const begin = trafficWorkerMeasurements({
            phase: 'paced',
            onUnsafe: () => {
                unsafe = true;
            },
            persist: async (value) => {
                saved = value;
            },
            workerFactory: fake,
        }),
        measurement = await begin({
            runId: run,
            phase: 'paced',
            collectionId: 'primary',
        }),
        result = await measurement.finish();
    assert(!unsafe);
    assert.equal(result.phase, 'paced');
    assert.equal(result.samples, 2);
    assert.equal(result.rawPrimitivePhaseTag, 'full');
    assert.equal(saved.samplerThread.explicitGuards, 1);
    assert.throws(() =>
        checkedWorkerSummary({ ...workerSummary(), rawSQL: 'private' })
    );
    assert.throws(() =>
        checkedWorkerSummary({ ...workerSummary(), oom: true })
    );
    await assert.rejects(() => begin({ phase: 'paced' }));
});
test('owned sampler thread is disposed on timeout, unsafe notification or wrong START scope and never persists a foreign result', async () => {
    for (const mode of ['timeout', 'unsafe', 'wrong-scope']) {
        let disposed = 0,
            saved = 0,
            unsafe = 0;
        const factory = () => {
            const worker = new EventEmitter();
            worker.terminate = () => {
                disposed++;
                return Promise.reject(new Error('synthetic termination'));
            };
            worker.unref = () => {};
            worker.postMessage = (message) => {
                queueMicrotask(() => {
                    if (message.type === 'START')
                        worker.emit('message', {
                            type: mode === 'unsafe' ? 'UNSAFE' : 'STARTED',
                        });
                    else
                        worker.emit('message', {
                            type: 'FINISHED',
                            summary: {
                                ...workerSummary(),
                                collectionId: 'foreign',
                            },
                            harness: workerHarness(),
                        });
                });
            };
            if (mode !== 'timeout')
                queueMicrotask(() => worker.emit('message', { type: 'READY' }));
            return worker;
        };
        const begin = trafficWorkerMeasurements({
            phase: 'paced',
            onUnsafe: () => unsafe++,
            persist: async () => saved++,
            workerFactory: factory,
            timeoutMs: 5,
        });
        await assert.rejects(async () => {
            const measurement = await begin({
                runId: run,
                phase: 'paced',
                collectionId: 'primary',
            });
            await measurement.finish();
        });
        await Promise.resolve();
        assert.equal(disposed, 1);
        assert(unsafe >= 1);
        assert.equal(saved, 0);
    }
});
test('post-proof budget is checked after each awaited read before any next API or expensive snapshot', async () => {
    const f = oracleFixture();
    let expired = false,
        calls = 0;
    await assert.rejects(() =>
        followTrafficSources({
            sources: [
                {
                    organization: 'A',
                    documentId: 'doc',
                    version: 1,
                    source: { index: 0 },
                    receipt: 'synthetic',
                    collectionId: 'col',
                },
            ],
            oracle: { sourceDocument: () => f.doc },
            check: () => assert(!expired),
            api: {
                async call() {
                    calls++;
                    expired = true;
                    return { value: {} };
                },
            },
        })
    );
    assert.equal(calls, 1);
    const fullReport = {
        documents: {
            loadA: Array.from({ length: 200 }, (_, i) => ({
                documentId: 'doc' + i,
                versionId: 'v' + i,
            })),
        },
        collections: {
            primary: { collectionId: 'primary' },
            pilot: { collectionId: 'pilot' },
        },
        baseline: {
            documents: { referenceB: [] },
            collections: {
                referenceB: { collectionId: 'reference' },
                ingestionA: { collectionId: 'ia' },
                ingestionB: { collectionId: 'ib' },
            },
        },
    };
    expired = false;
    calls = 0;
    let snapshots = 0;
    await assert.rejects(() =>
        verifyTrafficServingState({
            api: {
                async call() {
                    calls++;
                    expired = true;
                    return {
                        value: {
                            total: 200,
                            items: Array.from({ length: 100 }, (_, i) => ({
                                id: 'doc' + i,
                            })),
                        },
                    };
                },
            },
            observer: {
                async observeGeneration() {
                    snapshots++;
                },
            },
            fullReport,
            fixture,
            ingestion: { A: [], B: [] },
            content: {
                manifest: { documents: [] },
                references: { manifest: { documents: [] } },
            },
            check: () => assert(!expired),
        })
    );
    assert.equal(calls, 1);
    assert.equal(snapshots, 0);
});
test('concrete CLI context rejects an invalid state path before private reads even when enabled; private run files are exclusive and own-only', async () => {
    await assert.rejects(
        () =>
            createLoadTrafficContext(
                {
                    statePath: '/synthetic-invalid/state.json',
                    runId: run,
                    mode: 'traffic',
                },
                []
            ),
        /LOAD_OBS_(?:RUNTIME_DISABLED|TRAFFIC_ARGUMENTS)/u
    );
    const helperDirectory = path.join(root, 'tests/acceptance/capacity'),
        pinned = {
            ...state,
            phase: 'READY_FOR_LOAD_IMPORT',
            workflowHistory: ['pilot', 'full', 'traffic'],
            acceptanceSources: Object.fromEntries(
                [...LOAD_RUNTIME_HELPERS, ...TRAFFIC_RUNTIME_HELPERS].map(
                    (name) => [name, 'a'.repeat(64)]
                )
            ),
            loadProcess: {
                service: 'load',
                workflow: 'traffic',
                pid: process.pid,
                cwd: root,
                entry: path.join(helperDirectory, 'load-traffic-runtime.mjs'),
                entrySha256: 'a'.repeat(64),
                startTicks: '123',
                bootId: '12345678-1234-1234-1234-123456789abc',
            },
        };
    const context = {
        root,
        helperDirectory,
        statePath,
        state: pinned,
        fixture,
        runId: run,
        mode: 'traffic',
    };
    assert.equal(
        validateTrafficContext(context, TRAFFIC_RUNTIME_HELPERS).runId,
        run
    );
    assert.throws(() =>
        validateTrafficContext(
            {
                ...context,
                state: { ...pinned, workflowHistory: ['pilot', 'full'] },
            },
            TRAFFIC_RUNTIME_HELPERS
        )
    );
    for (const nested of [
        'load-traffic-async-guard.mjs',
        'load-traffic-resource-worker.mjs',
        'load-traffic-ingestion-observer-history.mjs',
    ]) {
        const wrong = {
            ...pinned,
            acceptanceSources: { ...pinned.acceptanceSources },
        };
        delete wrong.acceptanceSources[nested];
        assert.throws(() =>
            validateTrafficContext(
                { ...context, state: wrong },
                TRAFFIC_RUNTIME_HELPERS
            )
        );
    }
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-traffic-unit-')
    );
    try {
        fs.chmodSync(directory, 0o700);
        const files = createTrafficRunFiles(directory);
        files.assertAbsent('load-traffic-invocation.json');
        files.writeJson('load-traffic-invocation.json', { synthetic: true });
        assert.equal(
            fs.statSync(path.join(directory, 'load-traffic-invocation.json'))
                .mode & 0o777,
            0o600
        );
        assert.throws(() => files.assertAbsent('load-traffic-invocation.json'));
        assert.throws(() => files.writeJson('../secret', {}));
        assert.throws(() => files.directory('other'));
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
test('one-shot traffic invocation is persisted before any preload/adapter and interrupted preparation cannot replay', async () => {
    const full = {
        schemaVersion: 1,
        namespace: state.namespace,
        runId: run,
        workflow: 'full',
        status: 'COMPLETE',
        evidenceKind: 'LIVE_NATIVE_ISOLATED',
        acceptance: 'FULL_INDEX_PREPARED',
        capacityAcceptance: 'NOT_RUN',
        trafficAcceptance: 'NOT_RUN',
        familySha256: LOAD_IDENTITY.family,
        corpusSha256: LOAD_IDENTITY.full,
        baseline: { documents: { referenceB: Array.from({ length: 24 }) } },
        documents: { loadA: Array.from({ length: 200 }) },
        collections: { primary: { activeChildren: 100000, parents: 25000 } },
        fullObservation: {
            validatedNativeVectors: 100000,
            resourcePolicySha256: loadResourcePolicyHash(state),
        },
        timing: { fullIndexMs: 1 },
    };
    assert.equal(
        validateTrafficFullReport(full, full.baseline, summaryFor(full), state),
        full
    );
    assert.throws(() =>
        validateTrafficFullReport(
            { ...full, timing: { fullIndexMs: 7200001 } },
            full.baseline,
            summaryFor(full),
            state
        )
    );
    const files = new Map(),
        order = [],
        io = {
            admit: async () => {},
            assertAbsent: async (name) => {
                assert(!files.has(name));
            },
            writeJson: async (name, value) => {
                assert(!files.has(name));
                files.set(name, value);
                order.push(name);
            },
        };
    const attempt = () =>
        executeLoadTrafficWorkflow({
            state,
            fixture,
            fullReport: full,
            evidenceKind: 'LIVE_NATIVE_ISOLATED',
            io,
            oracle: null,
            prepareOracle: async () => {
                assert(files.has('load-traffic-invocation.json'));
                order.push('PRELOAD');
                throw new Error('private');
            },
            createPhaseIO: async () => assert.fail('no clients'),
        });
    await assert.rejects(attempt, /PREPARATION_FAILED/u);
    assert.deepEqual(order, [
        'load-traffic-invocation.json',
        'PRELOAD',
        'load-traffic-outcome.json',
    ]);
    assert(!JSON.stringify([...files.values()]).includes('private'));
    await assert.rejects(attempt);
});
