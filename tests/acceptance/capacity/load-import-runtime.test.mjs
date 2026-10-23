/** Synthetic/injected composition only. No real HTTP, database, Docker, model or process control. */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { importMock } from './load-import.test-helper.mjs';
import { createLoadSizeObserver } from './load-sizes.mjs';
import { digest, LoadObservationError } from './load-observer-core.mjs';
import { LoadTransportError } from './load-transport.mjs';
import { LoadSizeError } from './load-sizes.mjs';
import { safeFailure } from './load-import-runtime-policy.mjs';
import { sha, LOAD_IDENTITY } from './load-import-core.mjs';
import {
    createFrozenLoadContent,
    readPinnedLoadFile,
} from './load-import-runtime-content.mjs';
import {
    STATIC_DRAFT_ONLY,
    LOAD_RUNTIME_HELPERS,
    parseLoadImportArgs,
    validateLoadRuntimeContext,
    createLoadRuntimeFiles,
    executeLoadImportWorkflow,
    createLoadRuntimeServices,
    createSafeLoadFetch,
    runLoadImportCli,
} from './load-import-runtime.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)),
    root = path.resolve(here, '../../..');
function setup(options = {}) {
    const mock = importMock(options.mock),
        state = mock.state,
        runId = state.runId;
    Object.assign(state, {
        schemaVersion: 1,
        phase: 'READY_FOR_LOAD_IMPORT',
        workflowHistory: ['pilot'],
        applicationDatabase: `vectorix_m7c_load_app_${runId}_test`,
        vectorDatabase: `vectorix_m7c_load_vectors_${runId}_test`,
        lockfileSha256: 'c'.repeat(64),
        prismaConfigSha256: 'd'.repeat(64),
        migrations: { '20261021000000_initial': 'e'.repeat(64) },
        acceptanceSources: { 'load-import-runtime.mjs': 'f'.repeat(64) },
    });
    Object.assign(state.ports, {
        postgres: 45003,
        vector: 45004,
        redis: 45005,
        rustfs: 45006,
        ollama: 45007,
        admin: 45008,
    });
    Object.assign(state.environment, {
        DATABASE_URL: `postgresql://postgres:synthetic@127.0.0.1:45003/${state.applicationDatabase}`,
        VECTOR_DATABASE_URL: `postgresql://vectorix_runtime:synthetic@127.0.0.1:45004/${state.vectorDatabase}`,
    });
    state.resources = {};
    for (const [index, service] of [
        'postgres',
        'vector',
        'redis',
        'rustfs',
        'ollama',
    ].entries()) {
        state.resources[service] = {
            id: String(index + 1).repeat(64),
            imageId: 'sha256:' + 'a'.repeat(64),
            volumeIdentity: 'b'.repeat(64),
        };
        state.images[service] = 'sha256:' + 'a'.repeat(64);
        state.resourceLimits[service] ??= { cpus: '1', memoryBytes: 1024 ** 3 };
    }
    state.loadPolicy.model = { digest: LOAD_IDENTITY.weights };
    state.loadPolicy.minimumFreeBytes = 4 * 1024 ** 3;
    for (const name of LOAD_RUNTIME_HELPERS)
        state.acceptanceSources[name] = 'f'.repeat(64);
    state.loadProcess = {
        service: 'load',
        workflow: 'pilot',
        pid: process.pid,
        startTicks: '12345',
        bootId: '00000000-0000-0000-0000-000000000000',
        entry: path.join(here, 'load-import-runtime.mjs'),
        entrySha256: 'f'.repeat(64),
        cwd: root,
    };
    const context = {
        state,
        fixture: mock.fixture,
        root,
        helperDirectory: here,
        statePath: path.join(
            root,
            'node_modules/.cache/vectorix',
            'vectorix-m7c-load-' + runId,
            'state.json'
        ),
        runId,
        mode: 'pilot',
    };
    const store = new Map(),
        directories = new Set(),
        events = [];
    let unsafe = false,
        auth = 0,
        closed = 0,
        guards = 0;
    const io = {
        exists: (name) => store.has(name),
        assertAbsent: async (name) => {
            assert(
                !store.has(name) && !store.has(name + '.next'),
                'PRIVATE_EXISTING'
            );
        },
        readJson: async (name, max) => {
            assert(store.has(name), 'PRIVATE_MISSING');
            const value = store.get(name);
            assert(Buffer.byteLength(JSON.stringify(value)) <= max);
            return structuredClone(value);
        },
        writeJson: async (name, value, exclusive, max) => {
            assert(Buffer.byteLength(JSON.stringify(value)) <= max);
            if (exclusive) assert(!store.has(name), 'NO_OVERWRITE');
            await options.write?.(name, value);
            store.set(name, structuredClone(value));
            events.push(['write', name]);
        },
        ensureDirectory: async (name, create) => {
            if (create) assert(!directories.has(name), 'DIRECTORY_EXISTS');
            else assert(directories.has(name), 'DIRECTORY_MISSING');
            directories.add(name);
            return path.join(path.dirname(context.statePath), name);
        },
    };
    const admit = async () => {
        guards++;
        events.push(['guard']);
        if (options.guard) await options.guard(guards);
        const proof = {
            schemaVersion: 1,
            namespace: 'vectorix-m7c-load',
            runId,
            purpose: 'import',
            resourceOwnership: true,
            databaseReadOnly: true,
            bootstrapFreshness: false,
        };
        return options.proof ? options.proof(proof) : proof;
    };
    const createServices = async () => {
        events.push(['factory']);
        await options.createServices?.();
        assert(
            store.has(`load-${context.mode}-invocation.json`),
            'NO_DURABLE_INVOCATION'
        );
        const sizes = createLoadSizeObserver({
            state,
            fixture: mock.fixture,
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
            admit: async () => {},
            producerIdentity: async () => 'a'.repeat(64),
            now: mock.now,
            readDatabase: async (kind) => ({
                database:
                    kind === 'application'
                        ? state.applicationDatabase
                        : state.vectorDatabase,
                scope: kind === 'application' ? 'public' : 'vector_collections',
                transactionReadOnly: true,
                databaseBytes: '250000000',
                scopedRelationBytes: '1000000',
                relationCount: kind === 'application' ? 100 : 4,
            }),
            writeReceipt: async (name, value) => {
                assert(!store.has('store-sizes/' + name));
                store.set('store-sizes/' + name, structuredClone(value));
            },
        });
        return {
            api: {
                signIn: async () => {
                    auth++;
                    events.push(['auth']);
                    await options.signIn?.();
                },
                call: mock.api.call,
            },
            observer: {
                beginIndexObservation: mock.beginIndexObservation,
                observeGeneration: mock.observeGeneration,
            },
            beginMeasurements: async (request) => {
                const meter = await mock.beginMeasurements(request);
                return {
                    finish: async () => {
                        const value = {
                            ...(await meter.finish()),
                            phase: request.phase,
                            collectionId: request.collectionId,
                        };
                        store.set(
                            'load-resource-observations/resources-' +
                                request.phase +
                                '-summary.json',
                            structuredClone(value)
                        );
                        return value;
                    },
                };
            },
            observeStoreSizes: async (request) => {
                events.push(['size', request.phase, request.moment]);
                const value = await sizes.observeStoreSizes(request);
                return options.sizeReceipt ? options.sizeReceipt(value) : value;
            },
            assertSafe: () => {
                if (unsafe) throw Error('PRIVATE_UNSAFE');
            },
            close: async () => {
                closed++;
                events.push(['close']);
                await options.close?.();
            },
        };
    };
    const workflow = async () =>
        executeLoadImportWorkflow({
            context,
            io,
            content: {
                manifest: mock.manifest,
                references: mock.references,
                readOriginal: mock.readOriginal,
                readCanonical: async (descriptor) =>
                    mock.references.artifacts[descriptor.fixtureId],
            },
            createServices,
            admit,
            now: mock.now,
            sleep: mock.sleep,
        });
    return {
        mock,
        state,
        context,
        io,
        store,
        directories,
        events,
        workflow,
        setUnsafe: () => {
            unsafe = true;
        },
        full() {
            context.mode = 'full';
            state.workflowHistory = ['pilot', 'full'];
            state.loadProcess.workflow = 'full';
        },
        counts: () => ({ auth, closed, guards }),
    };
}
test('CLI and real-services factories refuse disabled or invalid entry before any context, files, client or guard', async () => {
    assert.equal(typeof STATIC_DRAFT_ONLY, 'boolean');
    const expected = STATIC_DRAFT_ONLY
        ? 'LOAD_RUNTIME_DISABLED'
        : 'LOAD_RUNTIME_ARGUMENTS';
    await assert.rejects(() => runLoadImportCli([]), { code: expected });
    await assert.rejects(
        () => createLoadRuntimeServices({ transportMode: 'INVALID' }),
        { code: expected }
    );
    const good = [
        '--state',
        '/synthetic/state.json',
        '--run',
        'abcdef012345',
        '--mode',
        'pilot',
    ];
    assert.equal(parseLoadImportArgs(good).mode, 'pilot');
    for (const args of [
        [],
        [...good, '--resume'],
        good.map((v) => (v === 'pilot' ? 'traffic' : v)),
        good.map((v) => (v === 'abcdef012345' ? 'bad' : v)),
    ])
        assert.throws(() => parseLoadImportArgs(args), {
            code: 'LOAD_RUNTIME_ARGUMENTS',
        });
});
test('wrong namespace, path, workflow order or exact foreground record refuses before clients', async () => {
    for (const change of [
        (io) => (io.state.namespace = 'vectorix-m7c-quality'),
        (io) => (io.context.statePath = '/somewhere/state.json'),
        (io) => (io.state.workflowHistory = []),
        (io) => (io.state.loadProcess.entry = '/somewhere/runtime.mjs'),
        (io) =>
            (io.state.environment.DATABASE_URL =
                'postgresql://postgres@remote/app'),
        (io) => io.state.loadProcess.pid++,
        (io) => delete io.state.acceptanceSources['load-sizes-runtime.mjs'],
    ]) {
        const io = setup();
        change(io);
        await assert.rejects(io.workflow);
        assert.equal(io.counts().auth, 0);
        assert.equal(io.mock.calls.length, 0);
        assert.equal(io.store.size, 0);
    }
});
test('guard rejection cannot create clients or accept mutations and never exposes raw diagnostics', async () => {
    const io = setup({
        guard: () => {
            throw Error('DO_NOT_LEAK_PRIVATE_CONFIG');
        },
    });
    await assert.rejects(
        io.workflow,
        (error) =>
            error.code === 'LOAD_RUNTIME_IMPORT_FAILED' &&
            !error.message.includes('PRIVATE')
    );
    assert.equal(io.store.size, 0);
    assert.equal(io.counts().auth, 0);
});
test('malformed or contradictory ownership proof fails closed before a client or private invocation', async () => {
    for (const change of [
        (proof) => ({ ...proof, resourceOwnership: false }),
        (proof) => ({ ...proof, unknownPrivilege: true }),
        (proof) => ({ ...proof, namespace: 'vectorix-m7c-quality' }),
    ]) {
        const io = setup({ proof: change });
        await assert.rejects(io.workflow, { code: 'LOAD_RUNTIME_GUARD' });
        assert.equal(io.store.size, 0);
        assert.equal(io.counts().auth, 0);
        assert.equal(io.mock.calls.length, 0);
    }
});
test('a well-hashed size receipt for the wrong new collection cannot advertise a completed pilot', async () => {
    const io = setup({
        sizeReceipt(value) {
            if (value.moment !== 'AFTER') return value;
            const { receiptSha256: _, ...payload } = value;
            payload.collectionId = 'other-collection';
            return { ...payload, receiptSha256: digest(payload) };
        },
    });
    await assert.rejects(io.workflow, { code: 'LOAD_RUNTIME_SIZE_PROOF' });
    assert.equal(io.store.has('load-pilot-report.json'), false);
    assert.equal(io.store.get('load-pilot-outcome.json').completed, false);
    assert.equal(io.counts().closed, 1);
});
test('pilot composes separate B24/empty baselines and native2k preparation with durable phase journals', async () => {
    const io = setup(),
        { report, summary } = await io.workflow();
    assert.equal(report.acceptance, 'NOT_RUN');
    assert.equal(report.collections.pilot.activeChildren, 2000);
    assert.equal(report.documents.loadA.length, 4);
    assert.equal(report.baseline.documents.referenceB.length, 24);
    assert.equal(report.storeSizes.before.physicalVolumeBytes, null);
    assert.equal(report.storeSizes.after.physicalVolumeStatus, 'UNKNOWN');
    assert.equal(summary.capacityAcceptance, 'NOT_RUN');
    assert.equal(summary.reportSha256, sha(JSON.stringify(report)));
    assert(io.store.has('load-baseline-journal.json'));
    assert(io.store.has('load-baseline-report.json'));
    assert(io.store.has('load-pilot-journal.json'));
    assert(io.store.has('load-pilot-report.json'));
    assert(io.store.has('load-pilot-outcome.json'));
    assert(
        io.events.findIndex(
            (e) => e[0] === 'write' && e[1] === 'load-pilot-invocation.json'
        ) < io.events.findIndex((e) => e[0] === 'factory')
    );
    assert(
        io.events.findIndex((e) => e[0] === 'close') <
            io.events.findIndex(
                (e) => e[0] === 'write' && e[1] === 'load-pilot-report.json'
            )
    );
    assert.equal(io.counts().auth, 1);
    assert.equal(io.counts().closed, 1);
    assert(
        !JSON.stringify([...io.store.values()]).includes(
            'SYNTHETIC_PRIVATE_PASSWORD'
        )
    );
});
test('existing invocation/journal/next files refuse one-shot replay without another API operation', async () => {
    for (const name of [
        'load-pilot-invocation.json',
        'load-pilot-journal.json',
        'load-pilot-report.json.next',
        'load-baseline-journal.json.next',
    ]) {
        const io = setup();
        io.store.set(name, {});
        await assert.rejects(io.workflow);
        assert.equal(io.counts().auth, 0);
        assert.equal(io.mock.calls.length, 0);
    }
    const io = setup();
    await io.workflow();
    const calls = io.mock.calls.length;
    await assert.rejects(io.workflow);
    assert.equal(io.mock.calls.length, calls);
});
test('failed before-dispatch journal or local safe-close leaves no advertised complete pilot', async () => {
    for (const fail of ['load-baseline-journal.json', 'close']) {
        const io = setup({
            write: (name) => {
                if (name === fail) throw Error('PRIVATE_DISK_WRITE');
            },
            close: () => {
                if (fail === 'close') throw Error('PRIVATE_CLOSE');
            },
        });
        await assert.rejects(
            io.workflow,
            (error) =>
                error.message.startsWith('LOAD_RUNTIME_') &&
                !error.message.includes('PRIVATE_')
        );
        assert(!io.store.has('load-pilot-report.json'));
        assert.equal(io.store.get('load-pilot-outcome.json').completed, false);
        if (fail !== 'close') assert.equal(io.mock.calls.length, 0);
    }
});
test('resource unsafe blocks new mutations and accepted upload stays ambiguous without replay', async () => {
    let io;
    io = setup({
        mock: {
            response: ({ operation, value }) => {
                if (operation === 'documents.upload') io.setUnsafe();
                return value;
            },
        },
    });
    await assert.rejects(io.workflow);
    assert.equal(
        io.mock.calls.filter((c) => c.operation === 'documents.upload').length,
        1
    );
    assert(!io.store.has('load-pilot-report.json'));
    const journal = io.store.get('load-baseline-journal.json');
    assert.equal(journal.status, 'INCOMPLETE');
    assert.equal(journal.acceptance, 'UNKNOWN');
});
test('full requires complete matching pilot outcome/resource/size receipts before authentication', async () => {
    const io = setup();
    await io.workflow();
    io.full();
    const auth = io.counts().auth;
    for (const name of [
        'load-pilot-outcome.json',
        'load-resource-observations/resources-pilot-summary.json',
        'store-sizes/store-sizes-pilot-before.json',
    ]) {
        const saved = structuredClone(io.store.get(name));
        io.store.set(name, { ...saved, runId: '000000000000' });
        await assert.rejects(io.workflow);
        assert.equal(io.counts().auth, auth);
        io.store.set(name, saved);
    }
});
test('full uses NEW100k generation before any traffic and all reports stay synthetic NOT_RUN', async () => {
    const io = setup(),
        pilot = (await io.workflow()).report;
    io.full();
    const { report } = await io.workflow();
    assert.equal(report.collections.primary.activeChildren, 100000);
    assert.equal(report.collections.primary.parents, 25000);
    assert.notEqual(
        report.collections.primary.generationId,
        pilot.collections.pilot.generationId
    );
    assert.equal(report.documents.loadA.length, 200);
    assert.equal(io.mock.documents.size, 224);
    assert.equal(report.trafficAcceptance, 'NOT_RUN');
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
    assert.equal(
        io.mock.calls.filter((c) => c.operation === 'indexing.search').length,
        0
    );
});
test('private file adapter refuses existing .next, symlinks and report overwrite; file and directory fsync helpers are real local only', async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-load-runtime-unit-')
    );
    fs.chmodSync(directory, 0o700);
    const { privateDirectory, readPrivate, privateCheckpoint } =
        await import('./load-private.mjs');
    try {
        const io = createLoadRuntimeFiles(directory, {
            privateDirectory,
            readPrivate,
            privateCheckpoint,
        });
        io.writeJson('load-pilot-invocation.json', { safe: true }, true, 512);
        assert.deepEqual(io.readJson('load-pilot-invocation.json', 512), {
            safe: true,
        });
        assert.throws(() =>
            io.writeJson(
                'load-pilot-invocation.json',
                { safe: false },
                true,
                512
            )
        );
        fs.writeFileSync(
            path.join(directory, 'load-pilot-journal.json.next'),
            '{}',
            { mode: 0o600 }
        );
        assert.throws(() => io.assertAbsent('load-pilot-journal.json'));
        fs.symlinkSync(
            '/dev/null',
            path.join(directory, 'load-full-report.json')
        );
        assert.throws(() => io.readJson('load-full-report.json', 512));
        assert.throws(() => io.readJson('../state.json', 512));
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
test('content capability rejects wrong generated bytes and permits only pinned reference files', async () => {
    const io = setup();
    const content = createFrozenLoadContent({
        manifest: io.mock.manifest,
        references: io.mock.references,
        readReferenceOriginal: io.mock.readOriginal,
        buildGenerated: () => Buffer.from('WRONG_SYNTHETIC_BYTES'),
        decodeText: () => ({}),
    });
    const spec = io.mock.manifest.documents[0];
    await assert.rejects(() =>
        content.readOriginal({
            fixtureId: spec.id,
            fileName: spec.filename,
            originalSha256: spec.sourceSha256,
            originalBytes: spec.bytes,
        })
    );
    assert.throws(() =>
        readPinnedLoadFile(here, { corpusFiles: {} }, '../../.env')
    );
    const reference = fs.readFileSync(
        path.join(here, '../quality/reference-v1/manifest.json')
    );
    assert.deepEqual(
        readPinnedLoadFile(
            here,
            { corpusFiles: { 'reference-v1/manifest.json': sha(reference) } },
            'reference-v1/manifest.json'
        ),
        reference
    );
    assert.throws(() =>
        readPinnedLoadFile(
            here,
            { corpusFiles: { 'reference-v1/manifest.json': '0'.repeat(64) } },
            'reference-v1/manifest.json'
        )
    );
});

test('unsafe raised during the awaited guard prevents the next normal RPC admission', async () => {
    let io;
    io = setup({
        guard: () => {
            if (
                io.store.get('load-baseline-journal.json')?.stage ===
                    'VERIFY_EMPTY_BASELINE' &&
                io.mock.calls.length === 0
            )
                io.setUnsafe();
        },
    });
    await assert.rejects(io.workflow);
    assert.equal(io.counts().auth, 1);
    assert.equal(io.mock.calls.length, 0);
    assert.equal(io.store.get('load-pilot-outcome.json').completed, false);
});

test('safe fetch checks after serialization or pacing before any underlying HTTP invocation', async () => {
    let unsafe = false,
        calls = 0;
    const fetch = createSafeLoadFetch(
        async () => {
            calls++;
            return 'SYNTHETIC';
        },
        () => {
            if (unsafe) throw Error('PRIVATE_UNSAFE');
        }
    );
    assert.equal(await fetch('synthetic'), 'SYNTHETIC');
    unsafe = true;
    assert.throws(() => fetch('synthetic'));
    assert.equal(calls, 1);
});

test('typed adapter diagnostics distinguish service construction and authentication without replay or raw errors', async () => {
    for (const [hook, failureStage, original, adapter] of [
        [
            'createServices',
            'CREATE_SERVICES',
            new LoadObservationError('LOAD_OBS_GUARD'),
            { kind: 'OBSERVATION', code: 'LOAD_OBS_GUARD', status: null },
        ],
        [
            'signIn',
            'AUTHENTICATE',
            new LoadTransportError('LOAD_RATE'),
            { kind: 'TRANSPORT', code: 'LOAD_RATE', status: null },
        ],
        [
            'signIn',
            'AUTHENTICATE',
            new LoadTransportError('LOAD_AUTH', {
                status: 403,
                acceptance: 'UNKNOWN',
            }),
            { kind: 'TRANSPORT', code: 'LOAD_AUTH', status: 403 },
        ],
    ]) {
        original.message = 'PRIVATE_TOKEN_OR_URL';
        original.stack = 'PRIVATE_STACK';
        original.cause = { url: 'PRIVATE_ENDPOINT' };
        const io = setup({
            [hook]: () => {
                throw original;
            },
            close: () => {
                throw Error('PRIVATE_CLOSE');
            },
        });
        await assert.rejects(io.workflow, (error) => {
            assert.equal(error.code, 'LOAD_RUNTIME_IMPORT_FAILED');
            assert.equal(error.failureStage, failureStage);
            assert.deepEqual(error.adapter, adapter);
            assert.equal(
                error.acceptance,
                original.acceptance === 'NOT_SENT' ? 'NOT_SENT' : 'UNKNOWN'
            );
            return true;
        });
        const outcome = io.store.get('load-pilot-outcome.json');
        assert.equal(outcome.failureStage, failureStage);
        assert.deepEqual(outcome.adapter, adapter);
        assert.equal(
            outcome.acceptance,
            original.acceptance === 'NOT_SENT' ? 'NOT_SENT' : 'UNKNOWN'
        );
        assert.equal(io.store.has('load-baseline-journal.json'), false);
        assert.equal(io.mock.calls.length, 0);
        assert(!JSON.stringify(outcome).includes('PRIVATE_'));
    }
});
test('diagnostics reject untyped lookalikes and unknown typed codes, preserving only finite safe stage evidence', () => {
    const lookalike = Object.assign(Error('PRIVATE_ERROR'), {
        code: 'LOAD_AUTH',
        status: 403,
        acceptance: 'UNKNOWN',
        failureStage: 'PRIVATE_STAGE',
        adapter: { kind: 'TRANSPORT', code: 'LOAD_AUTH', status: 403 },
    });
    const unknown = safeFailure(lookalike, 'AUTHENTICATE');
    assert.deepEqual(unknown.adapter, {
        kind: 'UNKNOWN',
        code: null,
        status: null,
    });
    assert.equal(unknown.failureStage, 'AUTHENTICATE');
    assert.equal(unknown.acceptance, 'UNKNOWN');
    assert.equal(
        safeFailure(lookalike, 'PRIVATE_STAGE').failureStage,
        'UNSPECIFIED'
    );
    const mutated = new LoadObservationError('LOAD_OBS_PRIVATE_SECRET');
    assert.deepEqual(safeFailure(mutated, 'CREATE_SERVICES').adapter, {
        kind: 'OBSERVATION',
        code: null,
        status: null,
    });
    const size = safeFailure(
        new LoadSizeError('LOAD_SIZE_DATABASE'),
        'MEASURE_BEFORE'
    );
    assert.deepEqual(size.adapter, {
        kind: 'STORE_SIZE',
        code: 'LOAD_SIZE_DATABASE',
        status: null,
    });
    assert.equal(safeFailure(size, 'PREFLIGHT').failureStage, 'MEASURE_BEFORE');
    assert.deepEqual(safeFailure(size).adapter, size.adapter);
    assert(!JSON.stringify(unknown).includes('PRIVATE_'));
});
test('baseline, close and final-report failures retain their exact bounded stage', async () => {
    for (const [failureStage, name] of [
        ['PREPARE_BASELINE', 'load-baseline-journal.json'],
        ['CLOSE_SERVICES', 'close'],
        ['WRITE_REPORT', 'load-pilot-report.json'],
    ]) {
        const io = setup({
            write: (file) => {
                if (file === name) throw Error('PRIVATE_FILE');
            },
            close: () => {
                if (name === 'close') throw Error('PRIVATE_CLOSE');
            },
        });
        await assert.rejects(io.workflow, (error) => {
            assert.equal(error.failureStage, failureStage);
            return true;
        });
        assert.equal(
            io.store.get('load-pilot-outcome.json').failureStage,
            failureStage
        );
        assert.equal(io.store.has('load-pilot-report.json'), false);
    }
});
