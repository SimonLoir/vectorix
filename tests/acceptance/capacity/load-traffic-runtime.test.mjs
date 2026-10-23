import {
    experimentFields,
    fixturePolicyFields,
    roleFields,
} from './load-observer.test-helper.mjs';
/** Synthetic transport events, clocks, APIs and numeric snapshots only. No socket/process/database/model action. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    trafficEventBridge,
    phaseDecision,
    executeTrafficPhase,
    waitTrafficStableWindow,
    parseLoadTrafficArgs,
    runLoadTrafficCli,
} from './load-traffic-runtime.mjs';
import { RequestTrace } from './load-traffic.mjs';
import { fields, sha } from './load-observer-core.mjs';
import {
    evaluateLoadSearch,
    readLoadSearchSnapshot,
} from './load-traffic-latency.mjs';
import { tinySource, ingestTiny } from './load-traffic-ingestion.mjs';
import { eligible, validateTrafficResult } from './load-traffic-oracle.mjs';
import {
    trafficEventProjection,
    createTrafficEvidenceStore,
} from './load-traffic-private.mjs';
import { wrapTrafficMeasurement } from './load-traffic-resources.mjs';
const run = '0123456789ab',
    organizationIds = ['orgA', 'orgB'],
    fixture = {
        ...fixturePolicyFields(),
        schemaVersion: 1,
        namespace: 'vectorix-m7c-load',
        runId: run,
        organizationIds,
        users: {
            owner: { userId: 'owner', organizationId: 'orgA' },
            reader: { userId: 'reader', organizationId: 'orgA' },
            foreign: { userId: 'foreign', organizationId: 'orgB' },
        },
    };
const state = {
    ...experimentFields(),
    schemaVersion: 1,
    namespace: 'vectorix-m7c-load',
    runId: run,
    applicationDatabase: `vectorix_m7c_load_app_${run}_test`,
    vectorDatabase: `vectorix_m7c_load_vectors_${run}_test`,
    ports: { postgres: 15432, vector: 15433 },
    environment: {
        DATABASE_URL: `postgresql://postgres:test@127.0.0.1:15432/vectorix_m7c_load_app_${run}_test`,
        VECTOR_DATABASE_URL: `postgresql://runtime:test@127.0.0.1:15433/vectorix_m7c_load_vectors_${run}_test`,
    },
};
function dimension(organizationId, mode, count = 0, bin = 7) {
    const native = mode !== 'LEXICAL',
        histogram = (samples) => ({
            samples: String(samples),
            sumMicros: String(samples * (bin === 8 ? 600000 : 400000)),
            buckets: Array.from({ length: 16 }, (_, i) =>
                i === bin ? String(samples) : '0'
            ),
        });
    return {
        organizationId,
        workload: 'SEARCH_' + mode,
        provider: native ? 'OLLAMA' : 'NONE',
        formatVersion: 1,
        knownGapReports: '0',
        failureClassTotal: '0',
        hours: ['2026-10-23T00:00:00.000Z'],
        counters: {
            ...Object.fromEntries(fields.map((field) => [field, '0'])),
            recordedStarts: String(count),
            recordedSuccesses: String(count),
            nativeStarts: String(native ? count : 0),
            nativeValidatedBatches: String(native ? count : 0),
            validatedVectors: String(native ? count : 0),
        },
        phases: {
            SERVICE_TOTAL: histogram(count),
            INTERNAL_PHASE_UNION: histogram(count),
            QUERY_EMBED: histogram(native ? count : 0),
        },
    };
}
const snapshot = (counts) => ({
    schemaVersion: 1,
    runId: run,
    producerIdentitySha256: 'a'.repeat(64),
    markers: organizationIds.map((organizationId) => ({
        organizationId,
        knownGapReports: '0',
    })),
    dimensions: organizationIds.flatMap((organizationId) =>
        ['LEXICAL', 'VECTOR', 'HYBRID'].map((mode) =>
            dimension(
                organizationId,
                mode,
                counts?.[organizationId]?.[mode] ?? 0
            )
        )
    ),
});
test('latency stability waits the full five seconds after an early wake without another observation or extended drain deadline', async () => {
    let clock = 123,
        observations = 1;
    const waits = [],
        sampledAt = clock,
        deadline = sampledAt + 6000000,
        advances = [0, 4999999, 0, 1];
    await waitTrafficStableWindow({
        now: () => clock,
        sleep: async (micros) => {
            waits.push(micros);
            clock += advances.shift();
        },
        check() {},
        sampledAt,
        deadline,
    });
    observations++;
    assert.deepEqual(waits, [5000000, 5000000, 1000, 1000]);
    assert(clock - sampledAt >= 5000000);
    assert(clock <= deadline);
    assert.equal(observations, 2);
});
test('stability early wakes cannot extend the original deadline or spin on a stalled clock', async () => {
    for (const advance of [
        () => 0,
        () => -1,
        (micros, count) => (count === 1 ? micros - 1 : micros),
    ]) {
        let clock = 100,
            sleeps = 0,
            observations = 1;
        await assert.rejects(
            async () => {
                await waitTrafficStableWindow({
                    now: () => clock,
                    sleep: async (micros) => {
                        clock += advance(micros, ++sleeps);
                    },
                    check() {},
                    sampledAt: 100,
                    deadline: 5000100,
                });
                observations++;
            },
            { code: 'LOAD_OBS_TRAFFIC_DEADLINE' }
        );
        assert.equal(observations, 1);
        assert.equal(sleeps, clock === 100 ? 64 : clock < 100 ? 1 : 2);
    }
});
test('AsyncLocalStorage binds same-role overlapping normal events and ends HTTP at body before validation', async () => {
    const trace = new RequestTrace();
    let at = 0;
    const bridge = trafficEventBridge(trace, {
            now: () => at,
            origin: 0,
            check: () => {},
        }),
        offer = (index) => ({
            id: 'A/' + index,
            organization: 'A',
            mode: 'HYBRID',
            dueMicros: 0,
        });
    trace.offer(offer(0), 0);
    trace.offer(offer(1), 0);
    let release;
    const waiting = new Promise((resolve) => (release = resolve));
    const first = bridge.run(
        { id: 'A/0', client: 'A0', organization: 'A' },
        async () => {
            bridge.onEvent({
                type: 'BEGIN',
                id: 'first',
                role: 'owner',
                operation: 'indexing.search',
                atMicros: at,
            });
            at = 1;
            bridge.onEvent({
                type: 'BODY',
                id: 'first',
                role: 'owner',
                operation: 'indexing.search',
                atMicros: at,
            });
            await waiting;
            trace.finish('A/0', 'SUCCESS', at);
        }
    );
    at = 2;
    await bridge.run(
        { id: 'A/1', client: 'A1', organization: 'A' },
        async () => {
            bridge.onEvent({
                type: 'BEGIN',
                id: 'second',
                role: 'owner',
                operation: 'indexing.search',
                atMicros: at,
            });
            at = 3;
            bridge.onEvent({
                type: 'BODY',
                id: 'second',
                role: 'owner',
                operation: 'indexing.search',
                atMicros: at,
            });
            trace.finish('A/1', 'SUCCESS', at);
        }
    );
    at = 4;
    release();
    await first;
    assert.equal(trace.snapshot().peakHTTPInFlight, 1);
    assert.equal(trace.snapshot().peakOccupiedSlots, 2);
    assert.equal(trace.snapshot().finished, 2);
});
test('exclusive search deltas pass only complete six pairs, with exact1s upper INCONCLUSIVE and extra/gap/failed traffic unmeasured', () => {
    const before = snapshot(),
        counts = Object.fromEntries(
            organizationIds.map((org) => [
                org,
                { LEXICAL: 100, VECTOR: 100, HYBRID: 100 },
            ])
        ),
        after = snapshot(counts),
        trace = {
            requests: ['A', 'B'].flatMap((organization) =>
                ['LEXICAL', 'VECTOR', 'HYBRID'].flatMap((mode) =>
                    Array.from({ length: 100 }, () => ({
                        organization,
                        mode,
                        state: 'FINISHED',
                        outcome: 'SUCCESS',
                    }))
                )
            ),
            occupiedSlots: 0,
            transportInFlight: 0,
            afterDrainDeadline: false,
        };
    assert.equal(
        evaluateLoadSearch({ before, after, fixture, trace }).status,
        'PASS'
    );
    const boundary = structuredClone(after);
    boundary.dimensions[0] = dimension('orgA', 'LEXICAL', 100, 8);
    assert.equal(
        evaluateLoadSearch({ before, after: boundary, fixture, trace }).status,
        'INCONCLUSIVE'
    );
    for (const mutate of [
        (value) => (value.markers[0].knownGapReports = '1'),
        (value) =>
            value.dimensions.push({
                ...dimension('orgA', 'VECTOR', 1),
                provider: 'COHERE',
            }),
        (value) => (value.dimensions[1].counters.nativeStarts = '101'),
        (value) =>
            (value.dimensions[0].phases.INTERNAL_PHASE_UNION.samples = '99'),
    ]) {
        const invalid = structuredClone(after);
        mutate(invalid);
        assert.equal(
            evaluateLoadSearch({ before, after: invalid, fixture, trace })
                .status,
            'UNMEASURED'
        );
    }
});
test('new load SQL binding is read-only, exact _test scoped, server-aggregated and never invokes a quality validator', async () => {
    const calls = [],
        client = {
            async query(sql, args) {
                calls.push({ sql, args });
                if (sql.startsWith('SELECT current_database'))
                    return {
                        rows: [
                            {
                                database: state.applicationDatabase,
                                readonly: 'on',
                            },
                        ],
                    };
                if (sql.startsWith('SELECT count'))
                    return { rows: [{ count: '0', valid: null }] };
                return { rows: [] };
            },
        };
    const result = await readLoadSearchSnapshot(client, {
        state,
        fixture,
        producerIdentitySha256: 'a'.repeat(64),
    });
    assert.equal(result.dimensions.length, 0);
    assert.equal(
        calls[0].sql,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    assert(calls.some((row) => row.sql.includes('jsonb_array_elements_text')));
    assert(calls.some((row) => row.sql === 'COMMIT'));
    assert(!calls.some((row) => /\b(UPDATE|DELETE|INSERT)\b/u.test(row.sql)));
    await assert.rejects(() =>
        readLoadSearchSnapshot(client, {
            state: { ...state, applicationDatabase: 'production' },
            fixture,
            producerIdentitySha256: 'a'.repeat(64),
        })
    );
});
test('normal tiny source workflow journals before upload and preserves canonical/original bytes through CURRENT publication', async () => {
    let time = 30000000,
        created = null,
        metadata = null;
    const journal = [],
        calls = [];
    const source = tinySource(run, 'paced', 'A', 0),
        api = {
            async call(role, operation, input) {
                calls.push(operation);
                assert.equal(role, 'owner');
                if (operation === 'documents.upload') {
                    assert.equal(journal.at(-1).status, 'PENDING');
                    assert.equal(input.requestId, journal.at(-1).requestId);
                    created = input.file;
                    time += 1000;
                    return {
                        value: { id: 'doc', versionId: 'version' },
                        http: {
                            startedMicros: 30000001,
                            bodyReadMicros: 30000500,
                            endedMicros: 30000999,
                        },
                    };
                }
                if (operation === 'documents.details')
                    return {
                        value: {
                            document: {
                                name: source.fileName,
                                status: 'READY',
                            },
                            canManage: true,
                            version: {
                                id: 'version',
                                version: 1,
                                status: 'READY',
                                stored: true,
                                byteSize: source.originalBytes,
                                mediaType: 'text/plain',
                            },
                        },
                    };
                if (operation === 'documents.download')
                    return { value: created };
                if (operation === 'documents.preview')
                    return {
                        value: {
                            text: source.text,
                            nextOffset: null,
                            version: 1,
                        },
                    };
                if (operation === 'documents.setCollection')
                    return { value: { success: true } };
                if (operation === 'indexing.updateMetadata') {
                    metadata = input;
                    return { value: { success: true } };
                }
                if (operation === 'indexing.documents')
                    return {
                        value: {
                            total: 1,
                            items: [
                                {
                                    documentId: 'doc',
                                    libraryVersion: 1,
                                    indexedVersion: 1,
                                    pending: false,
                                    freshness: 'CURRENT',
                                    errorCode: null,
                                    ...metadata,
                                },
                            ],
                        },
                    };
                assert.fail(operation);
            },
        };
    const result = await ingestTiny({
        runId: run,
        phase: 'paced',
        organization: 'A',
        index: 0,
        collection: { collectionId: 'ingest' },
        api,
        now: () => time,
        sleep: async (ms) => (time += ms),
        deadline: 300000000,
        journal: async (value) => journal.push(value),
    });
    assert.equal(result.binding.documentId, 'doc');
    assert.equal(result.timing.uploadIntentAtMicros, 30000000);
    assert.equal(result.timing.validatedUploadResponseAtMicros, 30001000);
    assert(
        result.timing.readyAtMicros >=
            result.timing.validatedUploadResponseAtMicros
    );
    assert.equal(result.timing.uploadHTTP.bodyReadMicros, 30000500);
    assert.equal(journal.length, 6);
    assert.equal(journal.filter((row) => row.status === 'ACCEPTED').length, 3);
    assert(!JSON.stringify(journal).includes(source.text));
});
test('traffic journals use closed numeric/hash projections and cannot persist arbitrary receipt/query/body fields', () => {
    const event = {
        kind: 'SEARCH_INTENT',
        phase: 'paced',
        id: 'A/0',
        client: 'A0',
        organization: 'A',
        mode: 'HYBRID',
        dueMicros: 0,
        requestSha256: 'a'.repeat(64),
        query: 'PRIVATE',
        receipt: 'PRIVATE',
    };
    assert(!JSON.stringify(trafficEventProjection(event)).includes('PRIVATE'));
    assert.throws(() =>
        trafficEventProjection({ ...event, requestSha256: 'SECRET' })
    );
    assert.equal(
        phaseDecision(
            'closed-loop',
            {
                requests: [],
                occupiedSlots: 0,
                transportInFlight: 0,
                afterDrainDeadline: false,
            },
            { status: 'PASS' },
            [],
            true
        ),
        'INCONCLUSIVE'
    );
});
test('traffic wrapper preserves actual numeric sampler result with explicit phase and raw tag', async () => {
    let persisted;
    const begin = wrapTrafficMeasurement(
            async (request) => {
                assert.equal(request.phase, 'full');
                return {
                    assertSafe() {},
                    finish: async () => ({
                        phase: 'full',
                        samples: 2,
                        peakMemoryBytes: 10,
                    }),
                };
            },
            'paced',
            async (value) => (persisted = value)
        ),
        measurement = await begin({
            runId: run,
            phase: 'paced',
            collectionId: 'primary',
        }),
        result = await measurement.finish();
    assert.equal(result.phase, 'paced');
    assert.equal(result.rawPrimitivePhaseTag, 'full');
    assert.equal(result.measurementPurpose, 'TRAFFIC');
    assert.equal(result, persisted);
});
test('CLI parser remains exact and runtime factories refuse before files/clients/resources', async () => {
    assert.deepEqual(
        parseLoadTrafficArgs([
            '--state',
            '/tmp/state.json',
            '--run',
            run,
            '--mode',
            'traffic',
        ]),
        { statePath: '/tmp/state.json', runId: run, mode: 'traffic' }
    );
    assert.throws(() =>
        parseLoadTrafficArgs([
            '--state',
            'relative',
            '--run',
            run,
            '--mode',
            'traffic',
        ])
    );
    // An enabled entry still receives an invalid argument list; it cannot discover a real state or construct clients.
    await assert.rejects(
        () => runLoadTrafficCli([]),
        (error) =>
            [
                'LOAD_OBS_RUNTIME_DISABLED',
                'LOAD_OBS_TRAFFIC_ARGUMENTS',
            ].includes(error.code)
    );
    // The injected admission always refuses before any directory is read, irrespective of the runtime flag.
    await assert.rejects(
        () =>
            createTrafficEvidenceStore({
                admit: async () => {
                    throw new Error('SYNTHETIC_ADMISSION_REFUSED');
                },
            }),
        (error) =>
            error.code === 'LOAD_OBS_RUNTIME_DISABLED' ||
            error.message === 'SYNTHETIC_ADMISSION_REFUSED'
    );
});
function phaseFixture() {
    let clock = 1000000,
        request = 0;
    const counts = Object.fromEntries(
            organizationIds.map((org) => [
                org,
                { LEXICAL: 0, VECTOR: 0, HYBRID: 0 },
            ])
        ),
        docs = new Map(),
        journal = [],
        files = new Map();
    const ingestionApi = {
        async call(role, operation, input) {
            if (operation === 'documents.upload') {
                const id = 'doc' + docs.size,
                    doc = {
                        id,
                        role,
                        file: input.file,
                        source: null,
                        metadata: null,
                        collectionId: null,
                    };
                files.set(id, input.file);
                docs.set(id, doc);
                return { value: { id, versionId: id + '-v1' } };
            }
            const doc = docs.get(input.id ?? input.documentId);
            if (operation === 'documents.details')
                return {
                    value: {
                        document: { name: doc.file.name, status: 'READY' },
                        version: {
                            id: doc.id + '-v1',
                            version: 1,
                            status: 'READY',
                            stored: true,
                            byteSize: doc.file.size,
                            mediaType: 'text/plain',
                        },
                    },
                };
            if (operation === 'documents.download') return { value: doc.file };
            if (operation === 'documents.preview')
                return {
                    value: {
                        text: await doc.file.text(),
                        nextOffset: null,
                        version: 1,
                    },
                };
            if (operation === 'documents.setCollection') {
                doc.collectionId = input.collectionId;
                return { value: { success: true } };
            }
            if (operation === 'indexing.updateMetadata') {
                doc.metadata = input;
                return { value: { success: true } };
            }
            if (operation === 'indexing.documents') {
                const items = [...docs.values()]
                    .filter(
                        (row) =>
                            row.role === role &&
                            row.collectionId === input.collectionId &&
                            row.metadata
                    )
                    .map((row) => ({
                        documentId: row.id,
                        libraryVersion: 1,
                        indexedVersion: 1,
                        pending: false,
                        freshness: 'CURRENT',
                        errorCode: null,
                        ...row.metadata,
                    }));
                return { value: { total: items.length, items } };
            }
            assert.fail(operation);
        },
    };
    const io = {
        admit: async () => {},
        assertSafe() {},
        verifyImmutable: async () => true,
        journal: async (row) => journal.push(row),
        now: () => clock,
        sleep: async (amount) => {
            clock += amount;
            await new Promise((resolve) => setImmediate(resolve));
        },
        ingestionApi,
        latency: { snapshot: async () => snapshot(counts) },
        ingestionObserver: {
            begin: async () => ({ baselineSha256: 'b'.repeat(64) }),
            finish: async (input) => ({
                kind: 'INGESTION_PHASE_PROOF',
                runId: run,
                phase: input.phase,
                collectionRole: input.collectionRole,
                policySha256: input.policySha256,
                newPublishedDocuments: 3,
                currentDocuments: input.priorBindings.length + 3,
                sourceTuplesVerified: true,
                canonicalLayoutVerified: true,
                physicalManifestsVerified: true,
                accountingVerified: true,
                noCurrentFailures: true,
                cleanupHealth: 'CLEAN',
                failedOutstandingCleanupTasks: 0,
            }),
        },
        beginMeasurements: async () => ({
            finish: async () => ({
                oom: false,
                processLost: false,
                safetyReserveBreached: false,
            }),
        }),
        followSources: async (sources) =>
            sources.map((source) => ({
                organization: source.organization,
                documentId: source.documentId,
                verified: true,
            })),
        finishEvidence: async (report) =>
            files.set('report', structuredClone(report)),
        openSearch: async ({ onEvent }) => ({
            async call(role, operation, input) {
                assert.equal(operation, 'indexing.search');
                const id = run + '-' + ++request,
                    started = clock;
                onEvent({
                    type: 'BEGIN',
                    id,
                    role,
                    operation,
                    atMicros: started,
                });
                await Promise.resolve();
                onEvent({ type: 'BODY', id, role, operation, atMicros: clock });
                onEvent({ type: 'END', id, role, operation, atMicros: clock });
                counts[role === 'owner' ? 'orgA' : 'orgB'][input.strategy]++;
                return {
                    value: { accepted: true },
                    http: {
                        requestId: id,
                        status: 200,
                        responseBytes: 10,
                        startedMicros: started,
                        bodyReadMicros: clock,
                        endedMicros: clock,
                    },
                };
            },
            close() {},
        }),
    };
    const oracle = {
        scheduleSha256: 'a'.repeat(64),
        request: (offer) => ({
            strategy: offer.mode,
            query: 'synthetic',
            filters: {},
        }),
        validate: (offer) => ({
            source: {
                organization: offer.organization,
                documentId: 'source-' + offer.organization,
            },
            safe: { generationId: 'generation', results: 1 },
        }),
    };
    const fullReport = {
        collections: { primary: { collectionId: 'primary' } },
        baseline: {
            collections: {
                ingestionA: {
                    ...roleFields('ingestionA'),
                    collectionId: 'ingestA',
                    generationId: 'generationA',
                },
                ingestionB: {
                    ...roleFields('ingestionB'),
                    collectionId: 'ingestB',
                    generationId: 'generationB',
                },
            },
        },
    };
    return { io, oracle, fullReport, journal, docs };
}
test('paced phase accounts all1800 immutable offers, six normal synthetic ingestion flows and six complete numeric cohorts', async () => {
    const fixtureIO = phaseFixture(),
        report = await executeTrafficPhase({
            phase: 'paced',
            state,
            fixture,
            ...fixtureIO,
        });
    assert.equal(report.status, 'PASS');
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
    assert.equal(report.searches, 1800);
    assert.equal(report.trace.finished, 1800);
    assert.equal(report.trace.dropped, 0);
    assert.equal(report.ingestion.length, 6);
    assert.equal(fixtureIO.docs.size, 6);
    assert.equal(report.sourceProofs.length, 6);
    assert.equal(report.latency.pairs.length, 6);
    assert.equal(
        fixtureIO.journal.filter((row) => row.kind === 'SEARCH_INTENT').length,
        1800
    );
    assert.equal(
        fixtureIO.journal.filter((row) => row.kind === 'SEARCH_FINISHED')
            .length,
        1800
    );
});
test('closed-loop enforces ten actual synthetic event intervals and reports early10k cap INCONCLUSIVE instead of PASS', async () => {
    const fixtureIO = phaseFixture(),
        report = await executeTrafficPhase({
            phase: 'closed-loop',
            state,
            fixture,
            ...fixtureIO,
        });
    assert.equal(report.searches, 10000);
    assert.equal(report.trace.peakHTTPInFlight, 10);
    assert.equal(report.trace.peakHTTPInFlightByOrganization.A, 5);
    assert.equal(report.trace.peakHTTPInFlightByOrganization.B, 5);
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
    assert.equal(report.trace.finished, 10000);
});
test('successful empty results keep exact SEARCH metrics but absent actual source coverage remains INCONCLUSIVE', async () => {
    const fixtureIO = phaseFixture();
    fixtureIO.oracle.validate = () => ({
        source: null,
        safe: {
            results: 0,
            vectorUnderfilled: true,
            parentUnderfilled: true,
            eligibleChildren: 100000,
            unfiltered: true,
        },
    });
    const report = await executeTrafficPhase({
        phase: 'paced',
        state,
        fixture,
        ...fixtureIO,
    });
    assert.equal(report.status, 'INCONCLUSIVE');
    assert.equal(report.latency.status, 'PASS');
    assert.equal(report.trace.finished, 1800);
    assert.equal(report.sourceCoverage.provenNonemptyPairs, 0);
    assert.equal(report.sourceProofs.length, 0);
    assert.equal(
        report.searchResults.reduce((sum, row) => sum + row.empty, 0),
        1800
    );
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
});
test('unresolved failed cleanup prevents overall PASS without erasing independent SEARCH latency or historical ingestion evidence', async () => {
    const fixtureIO = phaseFixture(),
        finish = fixtureIO.io.ingestionObserver.finish;
    fixtureIO.io.ingestionObserver.finish = async (input) => ({
        ...(await finish(input)),
        cleanupHealth: 'UNRESOLVED_FAILED_CLEANUP',
        failedOutstandingCleanupTasks: 1,
        native: { recordedFailures: '1', recordedSupersessions: '1' },
    });
    const report = await executeTrafficPhase({
        phase: 'paced',
        state,
        fixture,
        ...fixtureIO,
    });
    assert.equal(report.status, 'FAIL');
    assert.equal(report.latency.status, 'PASS');
    assert.equal(
        report.ingestionProofs.A.cleanupHealth,
        'UNRESOLVED_FAILED_CLEANUP'
    );
    assert.equal(report.ingestionProofs.A.native.recordedFailures, '1');
    assert.equal(report.trace.finished, 1800);
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
});
