/** Guarded load-only CLI composition. Imports are inert; no file, SDK or resource is touched before admission. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
    need,
    hash,
    same,
    validateIdentity,
    digest,
} from './load-observer-core.mjs';
import {
    validateLoadTransportState,
    createLoadTransport,
} from './load-transport.mjs';
import {
    loadResourcePolicyHash,
    LOAD_IDENTITY,
    loadProfile,
} from './load-import-core.mjs';
import {
    summaryFor,
    LOAD_RUNTIME_HELPERS,
} from './load-import-runtime-policy.mjs';
import {
    privateDirectory,
    readPrivate,
    privateCheckpoint,
    discoverWorkspace,
} from './load-private.mjs';
import {
    loadObserverGuard,
    loadObservationPackages,
    createLoadObservationRuntime,
} from './load-observer-runtime.mjs';
import {
    loadRuntimeContent,
    readPinnedLoadFile,
} from './load-import-runtime-content.mjs';
import { createTrafficCatalogRuntime } from './load-traffic-catalog.mjs';
import { prepareTrafficOracle } from './load-traffic-oracle.mjs';
import { createLoadTrafficLatencyRuntime } from './load-traffic-latency.mjs';
import { createTrafficIngestionRuntime } from './load-traffic-ingestion-observer-runtime.mjs';
import { createTrafficResourceRuntime } from './load-traffic-resources.mjs';
import { createTrafficEvidenceStore } from './load-traffic-private.mjs';
import { verifyTrafficServingState } from './load-traffic-inventory.mjs';
import { followTrafficSources } from './load-traffic-sources.mjs';
import { createTrafficGuard } from './load-traffic-async-guard.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MICRO = () => Math.round(performance.now() * 1000);
const sleep = (us) => new Promise((resolve) => setTimeout(resolve, us / 1000));
/** Preserve the eleven-second gap between auth sequences despite an early timer wake; never replay authentication. */
export async function waitTrafficAuthCooldown({
    lastAuthFinished,
    now,
    sleep,
    assertSafe,
}) {
    assertSafe();
    if (lastAuthFinished === null) return;
    need(Number.isSafeInteger(lastAuthFinished), 'LOAD_OBS_TRAFFIC_DEADLINE');
    const target = lastAuthFinished + 11000000;
    let previous = lastAuthFinished,
        wakes = 0;
    while (true) {
        assertSafe();
        const before = now();
        need(
            Number.isSafeInteger(before) && before >= previous,
            'LOAD_OBS_TRAFFIC_DEADLINE'
        );
        const remaining = target - before;
        if (remaining <= 0) return;
        need(++wakes <= 64, 'LOAD_OBS_TRAFFIC_DEADLINE');
        await sleep(Math.ceil(remaining / 1000) * 1000);
        assertSafe();
        previous = now();
        need(
            Number.isSafeInteger(previous) && previous >= before,
            'LOAD_OBS_TRAFFIC_DEADLINE'
        );
    }
}
const FILES = new Set([
    'load-traffic-invocation.json',
    'load-traffic-prepared.json',
    'load-traffic-report.json',
    'load-traffic-outcome.json',
]);
const DIRECTORIES = new Set([
    'traffic-paced',
    'traffic-closed-loop',
    'traffic-resources-paced',
    'traffic-resources-closed-loop',
    'ingestion-native-receipts',
]);

/** Require the exact once-only foreground entry and private load run; the Python guard independently checks live ownership. */
export function validateTrafficContext(
    { root, helperDirectory, statePath, state, fixture, runId, mode },
    helpers
) {
    validateIdentity(state, fixture);
    validateLoadTransportState(state, fixture);
    const directory = path.join(
            root,
            'node_modules/.cache/vectorix',
            state.prefix
        ),
        caller = state.loadProcess;
    need(
        path.isAbsolute(root) &&
            helperDirectory === path.join(root, 'tests/acceptance/capacity') &&
            statePath === path.join(directory, 'state.json') &&
            runId === state.runId &&
            mode === 'traffic' &&
            state.prefix === 'vectorix-m7c-load-' + runId &&
            state.phase === 'READY_FOR_LOAD_IMPORT' &&
            same(state.workflowHistory, ['pilot', 'full', 'traffic']),
        'LOAD_OBS_TRAFFIC_CONTEXT'
    );
    need(
        caller?.service === 'load' &&
            caller.workflow === 'traffic' &&
            caller.pid === process.pid &&
            caller.cwd === root &&
            caller.entry ===
                path.join(helperDirectory, 'load-traffic-runtime.mjs') &&
            hash(caller.entrySha256) &&
            caller.entrySha256 ===
                state.acceptanceSources?.['load-traffic-runtime.mjs'] &&
            typeof caller.startTicks === 'string' &&
            /^[0-9]{1,30}$/u.test(caller.startTicks) &&
            /^[a-f0-9-]{36}$/u.test(caller.bootId) &&
            Array.isArray(helpers) &&
            [...LOAD_RUNTIME_HELPERS, ...helpers].every((name) =>
                hash(state.acceptanceSources?.[name])
            ),
        'LOAD_OBS_TRAFFIC_CONTEXT'
    );
    return {
        root,
        helperDirectory,
        statePath,
        state,
        fixture,
        runId,
        mode,
        runDirectory: directory,
    };
}

/** Only a completed full report and its exact immutable baseline/outcome authorize traffic preparation. */
export function validateTrafficFullReport(full, baseline, outcome, state) {
    need(
        full?.schemaVersion === 1 &&
            full.namespace === state.namespace &&
            full.runId === state.runId &&
            full.workflow === 'full' &&
            full.status === 'COMPLETE' &&
            full.evidenceKind === 'LIVE_NATIVE_ISOLATED' &&
            full.acceptance === 'FULL_INDEX_PREPARED' &&
            full.capacityAcceptance === 'NOT_RUN' &&
            full.trafficAcceptance === 'NOT_RUN' &&
            full.familySha256 === LOAD_IDENTITY.family &&
            full.corpusSha256 === LOAD_IDENTITY.full &&
            same(full.baseline, baseline) &&
            same(summaryFor(full), outcome),
        'LOAD_OBS_FULL_REPORT'
    );
    need(
        full.documents?.loadA?.length === 200 &&
            full.baseline.documents?.referenceB?.length === 24 &&
            full.collections?.primary?.activeChildren === 100000 &&
            full.collections.primary.parents === 25000 &&
            full.fullObservation?.validatedNativeVectors === 100000 &&
            full.fullObservation.resourcePolicySha256 ===
                loadResourcePolicyHash(state) &&
            Number.isSafeInteger(full.timing?.fullIndexMs) &&
            full.timing.fullIndexMs > 0 &&
            full.timing.fullIndexMs <= 7200000,
        'LOAD_OBS_FULL_REPORT'
    );
    return full;
}

/** Private fixed capabilities; fresh children and checkpoints cannot reuse an interrupted traffic invocation. */
export function createTrafficRunFiles(directory) {
    privateDirectory(directory);
    const file = (name) => {
        need(FILES.has(name), 'LOAD_OBS_TRAFFIC_PRIVATE');
        return path.join(directory, name);
    };
    const absent = (target) => {
        try {
            fs.lstatSync(target);
            throw new Error('LOAD_OBS_TRAFFIC_PRIOR_PROGRESS');
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    };
    return {
        assertAbsent(name) {
            absent(file(name));
            absent(file(name) + '.next');
        },
        writeJson(name, value, exclusive = true) {
            need(
                Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 ** 2,
                'LOAD_OBS_TRAFFIC_PRIVATE'
            );
            privateCheckpoint(file(name), value, exclusive);
        },
        directory(name) {
            need(DIRECTORIES.has(name), 'LOAD_OBS_TRAFFIC_PRIVATE');
            const target = path.join(directory, name);
            fs.mkdirSync(target, { mode: 0o700 });
            privateDirectory(target);
            return target;
        },
    };
}

/** Concrete adapters remain independently disabled; even a caller bypassing the entry flag cannot construct clients. */
export async function createLoadTrafficContext(parsed, helpers) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    const root = discoverWorkspace(HERE),
        runDirectory = path.join(
            root,
            'node_modules/.cache/vectorix',
            'vectorix-m7c-load-' + parsed.runId
        );
    need(
        parsed.statePath === path.join(runDirectory, 'state.json'),
        'LOAD_OBS_TRAFFIC_ARGUMENTS'
    );
    privateDirectory(runDirectory);
    const decode = (bytes) =>
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const state = decode(readPrivate(parsed.statePath, 128 * 1024)),
        fixture = decode(
            readPrivate(path.join(runDirectory, 'fixture.json'), 128 * 1024)
        );
    const context = validateTrafficContext(
        { ...parsed, root, helperDirectory: HERE, state, fixture },
        helpers
    );
    const guard = createTrafficGuard({ state, statePath: parsed.statePath });
    const admit = async () => {
        await guard.admit();
        need(
            same(decode(readPrivate(parsed.statePath, 128 * 1024)), state),
            'LOAD_OBS_TRAFFIC_STATE_DRIFT'
        );
    };
    await admit();
    // No user dot-env, cloud profile or inherited credentials are available to SDK/default chains.
    for (const key of Object.keys(process.env))
        if (!['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key))
            delete process.env[key];
    const fullReport = validateTrafficFullReport(
        decode(
            readPrivate(
                path.join(runDirectory, 'load-full-report.json'),
                8 * 1024 ** 2
            )
        ),
        decode(
            readPrivate(
                path.join(runDirectory, 'load-baseline-report.json'),
                8 * 1024 ** 2
            )
        ),
        decode(
            readPrivate(
                path.join(runDirectory, 'load-full-outcome.json'),
                512 * 1024
            )
        ),
        state
    );
    const files = createTrafficRunFiles(runDirectory);
    let unsafe = false,
        closed = false,
        wireFactory = null,
        importWire = null,
        content = null,
        observer = null,
        latency = null,
        ingestionObserver = null,
        packages = null,
        lastAuthFinished = null,
        ingestionDeadline = null;
    const assertSafe = () =>
        need(!unsafe && !closed, 'LOAD_OBS_TRAFFIC_UNSAFE');
    const markUnsafe = () => {
        unsafe = true;
    };
    const bounded = async (operation, us) => {
        const deadline = MICRO() + us;
        const check = () => {
            assertSafe();
            need(MICRO() <= deadline, 'LOAD_OBS_TRAFFIC_PROOF_DEADLINE');
        };
        check();
        const value = await operation(check);
        check();
        return value;
    };
    const guardedApi = {
        call: async (...args) => {
            assertSafe();
            await admit();
            assertSafe();
            const value = await importWire.call(...args);
            assertSafe();
            return value;
        },
    };
    // Shared normal IMPORT traffic serializes all inventory/source/ingestion reads. Search has a separate10-slot transport.
    let queue = Promise.resolve();
    const api = {
        call(...args) {
            const next = queue.then(() => guardedApi.call(...args));
            queue = next.catch(() => {});
            return next;
        },
    };
    const signIn = async (wire) => {
        assertSafe();
        await admit();
        await waitTrafficAuthCooldown({
            lastAuthFinished,
            now: MICRO,
            sleep,
            assertSafe,
        });
        assertSafe();
        await wire.signIn();
        lastAuthFinished = MICRO();
        assertSafe();
    };
    const prepareOracle = async () => {
        await admit();
        assertSafe();
        content = await loadRuntimeContent({
            root,
            helperDirectory: HERE,
            state,
            admit,
        });
        content = {
            ...content,
            references: {
                ...content.references,
                queries: decode(
                    readPinnedLoadFile(HERE, state, 'reference-v1/queries.json')
                ),
                qrels: decode(
                    readPinnedLoadFile(HERE, state, 'reference-v1/qrels.json')
                ),
            },
        };
        packages = await loadObservationPackages(admit);
        const require = createRequire(path.join(root, 'apps/api/package.json'));
        const [{ createORPCClient }, { RPCLink }] = await Promise.all([
            import(pathToFileURL(require.resolve('@orpc/client')).href),
            import(pathToFileURL(require.resolve('@orpc/client/fetch')).href),
        ]);
        wireFactory = (mode, onEvent = () => {}) =>
            createLoadTransport({
                state,
                fixture,
                fetchImpl: (...args) => {
                    assertSafe();
                    if (mode === 'IMPORT' && ingestionDeadline !== null)
                        need(
                            MICRO() <= ingestionDeadline,
                            'LOAD_OBS_TRAFFIC_DEADLINE'
                        );
                    return globalThis.fetch(...args);
                },
                rpcFactory: (options) => createORPCClient(new RPCLink(options)),
                now: () => performance.now(),
                sleep: (ms) =>
                    new Promise((resolve) => setTimeout(resolve, ms)),
                mode,
                onEvent,
            });
        importWire = wireFactory('IMPORT');
        await signIn(importWire);
        privateDirectory(path.join(runDirectory, 'load-native-receipts'));
        observer = await createLoadObservationRuntime({
            state,
            fixture,
            statePath: parsed.statePath,
            receiptDirectory: path.join(runDirectory, 'load-native-receipts'),
            readCanonical: content.readCanonical,
            referenceMetadataFields: content.references.manifest.metadataFields,
        });
        await bounded(
            (check) =>
                verifyTrafficServingState({
                    api,
                    observer,
                    fullReport,
                    content,
                    fixture,
                    ingestion: { A: [], B: [] },
                    check,
                }),
            300000000
        );
        const catalogs = {},
            reader = await createTrafficCatalogRuntime({
                state,
                fixture,
                statePath: parsed.statePath,
            });
        for (const organization of ['A', 'B']) {
            const saved =
                organization === 'A'
                    ? fullReport.collections.primary
                    : fullReport.baseline.collections.referenceB;
            catalogs[organization] = await reader.catalog({
                organizationId:
                    fixture.users[organization === 'A' ? 'owner' : 'foreign']
                        .organizationId,
                collectionId: saved.collectionId,
                generationId: saved.generationId,
                bindings:
                    organization === 'A'
                        ? fullReport.documents.loadA
                        : fullReport.baseline.documents.referenceB,
            });
        }
        const profile = loadProfile();
        const oracle = await bounded(
            (check) =>
                prepareTrafficOracle({
                    state,
                    fullReport,
                    references: content.references,
                    manifest: content.manifest,
                    catalogs,
                    readCanonical: async (descriptor) => {
                        check();
                        const value = await content.readCanonical(descriptor);
                        check();
                        return value;
                    },
                    plan: (artifact, identity, title) => {
                        check();
                        const children = [
                                ...packages.chunking
                                    .resolveChunkingStrategy(
                                        profile.chunkingStrategy,
                                        'token-window-utf8-v1'
                                    )
                                    .plan(artifact, {
                                        ...profile.chunking,
                                        maxEmbeddingInputBytes:
                                            packages.embeddings.embeddingInputByteLimit(
                                                identity,
                                                {
                                                    kind: 'document',
                                                    title,
                                                    preparation: '',
                                                }
                                            ),
                                        maxChunks: 500,
                                    }),
                            ],
                            parent = packages.chunking.planParentContext(
                                artifact,
                                children,
                                { parentMaxTokens: 2048 }
                            );
                        check();
                        return {
                            children,
                            parents: parent.parents,
                            mapping: parent.childParentOrdinals,
                        };
                    },
                    prepareInput: packages.embeddings.prepareEmbeddingInput,
                }),
            300000000
        );
        latency = await createLoadTrafficLatencyRuntime({
            state,
            fixture,
            statePath: parsed.statePath,
        });
        ingestionObserver = await createTrafficIngestionRuntime({
            state,
            fixture,
            statePath: parsed.statePath,
            directory: files.directory('ingestion-native-receipts'),
        });
        return oracle;
    };
    const createPhaseIO = async ({ phase }) => {
        assertSafe();
        need(
            observer && wireFactory && latency && ingestionObserver,
            'LOAD_OBS_TRAFFIC_COMPOSITION'
        );
        const evidenceDirectory = files.directory('traffic-' + phase),
            evidence = await createTrafficEvidenceStore({
                directory: evidenceDirectory,
                phase,
                admit,
            }),
            resourceDirectory = files.directory('traffic-resources-' + phase);
        const calibration = [];
        for (let index = 0; index < 10; index++) {
            const started = MICRO();
            await sleep(20000);
            calibration.push(Math.max(0, MICRO() - started - 20000));
        }
        const calibrationProof = {
            runId: state.runId,
            phase,
            scope: 'PRECLOCK_TIMER_WAKE_CALIBRATION_NOT_PRODUCT_LATENCY',
            requestedMicros: 20000,
            observedWakeOverrunMicros: calibration,
            guard: guard.summary(),
        };
        privateCheckpoint(
            path.join(evidenceDirectory, 'harness-calibration.json'),
            calibrationProof,
            true
        );
        const beginMeasurements = await createTrafficResourceRuntime({
            state,
            fixture,
            statePath: parsed.statePath,
            phase,
            directory: resourceDirectory,
            onUnsafe: markUnsafe,
            persist: async (value) =>
                privateCheckpoint(
                    path.join(
                        resourceDirectory,
                        'traffic-' + phase + '-summary.json'
                    ),
                    value,
                    true
                ),
        });
        let wakes = 0,
            wakeTotalMicros = 0,
            wakeMaximumMicros = 0;
        const phaseSleep = async (us) => {
            const started = MICRO();
            await sleep(us);
            const late = Math.max(0, MICRO() - started - us);
            need(++wakes <= 20000, 'LOAD_OBS_TRAFFIC_TIMER_CAP');
            wakeTotalMicros += late;
            wakeMaximumMicros = Math.max(wakeMaximumMicros, late);
        };
        let search = null;
        return {
            admit,
            assertSafe,
            now: MICRO,
            sleep: phaseSleep,
            ingestionApi: api,
            latency,
            ingestionObserver,
            beginMeasurements,
            setDeadline: (value) => {
                need(
                    Number.isSafeInteger(value) &&
                        value > MICRO() &&
                        ingestionDeadline === null,
                    'LOAD_OBS_TRAFFIC_DEADLINE'
                );
                ingestionDeadline = value;
            },
            beginPostProof: () => {
                ingestionDeadline = null;
            },
            harnessSummary: () => ({
                calibrationSha256: digest(calibrationProof),
                timerWakeObservations: wakes,
                timerWakeTotalOverrunMicros: wakeTotalMicros,
                timerWakeMaximumOverrunMicros: wakeMaximumMicros,
                guard: guard.summary(),
                definition:
                    'CLIENT_SCHEDULER_TIMER_OVERRUN_AND_HARNESS_COMPONENTS_NOT_PRODUCT_ONLY_CAPACITY',
            }),
            journal: evidence.journal,
            finishEvidence: evidence.finishEvidence,
            openSearch: async ({ onEvent }) => {
                need(!search, 'LOAD_OBS_TRAFFIC_PRIOR_PROGRESS');
                search = wireFactory('TRAFFIC', onEvent);
                await signIn(search);
                return search;
            },
            verifyImmutable: async (_report, { ingestion }) =>
                bounded(
                    (check) =>
                        verifyTrafficServingState({
                            api,
                            observer,
                            fullReport,
                            content,
                            fixture,
                            ingestion,
                            check,
                        }),
                    300000000
                ),
            followSources: async (sources, oracle) =>
                bounded(
                    (check) =>
                        followTrafficSources({ sources, oracle, api, check }),
                    120000000
                ),
            close: async () => {
                ingestionDeadline = null;
                await evidence.close();
                if (search) search.close();
            },
        };
    };
    return {
        state,
        fixture,
        fullReport,
        oracle: null,
        prepareOracle,
        io: { ...files, admit },
        createPhaseIO,
        evidenceKind: 'LIVE_NATIVE_ISOLATED',
        close: async () => {
            try {
                await queue;
                if (importWire) importWire.close();
            } finally {
                closed = true;
            }
        },
    };
}
