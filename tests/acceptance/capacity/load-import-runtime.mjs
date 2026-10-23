#!/usr/bin/env node
/** Guarded load-only orchestration. Importing performs no I/O or client/process action. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { getLoadPolicy, loadPolicyForState } from './load-policy-registry.mjs';
import {
    loadResourcePolicyHash,
    same,
    validateManifest,
    validateReferences,
} from './load-import-core.mjs';
import {
    prepareLoadBaseline,
    importLoadPilot,
    importLoadFull,
    validatePilotGate,
} from './load-import-protocol.mjs';
import { SIZE_LIMITS } from './load-sizes.mjs';
import {
    LoadRuntimeError,
    RUNTIME_LIMITS,
    need,
    safeFailure,
    parseLoadImportArgs,
    validateLoadRuntimeContext,
    guardProof,
    pathsFor,
    CHILDREN,
    checkReport,
    checkSizes,
    summaryFor,
} from './load-import-runtime-policy.mjs';
import { createLoadRuntimeFiles } from './load-import-runtime-files.mjs';
import { createLoadRuntimeServices } from './load-import-runtime-services.mjs';
export {
    LoadRuntimeError,
    RUNTIME_LIMITS,
    LOAD_RUNTIME_HELPERS,
    parseLoadImportArgs,
    validateLoadRuntimeContext,
} from './load-import-runtime-policy.mjs';
export { createLoadRuntimeFiles } from './load-import-runtime-files.mjs';
export {
    createLoadRuntimeServices,
    createSafeLoadFetch,
} from './load-import-runtime-services.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Return the actual independently validated guard result; never reconstruct an older proof envelope. */
export function createLoadImportAdmission({ state, statePath, guard }) {
    loadPolicyForState(state);
    need(typeof guard === 'function', 'LOAD_RUNTIME_ADAPTER');
    return async () => {
        const proof = await guard({ state, statePath });
        guardProof(proof, { state, runId: state.runId });
        return proof;
    };
}
/**
 * One-shot orchestration with explicitly injected I/O/clients. Synthetic tests cannot become live reports.
 * Journals are durable before mutations; a crashed invocation is never resumed by replaying requests.
 */
async function executeLoadImportWorkflowChecked({
    context,
    io,
    content,
    createServices,
    admit,
    now,
    sleep,
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
    protocols = { prepareLoadBaseline, importLoadPilot, importLoadFull },
}) {
    context = validateLoadRuntimeContext(context);
    need(
        ['SYNTHETIC_UNIT_TEST', 'LIVE_NATIVE_ISOLATED'].includes(
            evidenceKind
        ) &&
            [
                admit,
                createServices,
                now,
                sleep,
                io?.exists,
                io?.readJson,
                io?.writeJson,
                io?.assertAbsent,
                io?.ensureDirectory,
                content?.readOriginal,
                content?.readCanonical,
            ].every((fn) => typeof fn === 'function'),
        'LOAD_RUNTIME_ADAPTER'
    );
    const guarded = async () => guardProof(await admit(), context);
    await guarded();
    const policy = loadPolicyForState(context.state);
    validateManifest(content.manifest, policy);
    validateReferences(content.references, policy);
    const names = pathsFor(context.mode);
    for (const name of Object.values(names)) await io.assertAbsent(name);
    if (context.mode === 'pilot')
        for (const name of [
            'load-baseline-journal.json',
            'load-baseline-report.json',
        ])
            await io.assertAbsent(name);
    let prior = null;
    if (context.mode === 'full') {
        prior = await io.readJson(
            'load-pilot-report.json',
            RUNTIME_LIMITS.reportBytes
        );
        try {
            validatePilotGate(prior, { state: context.state, evidenceKind });
        } catch {
            throw new LoadRuntimeError('LOAD_RUNTIME_PILOT_GATE');
        }
        checkReport(prior, context, 'pilot', evidenceKind);
        const priorOutcome = await io.readJson(
            'load-pilot-outcome.json',
            RUNTIME_LIMITS.journalBytes
        );
        need(same(priorOutcome, summaryFor(prior)), 'LOAD_RUNTIME_PILOT_GATE');
        const baseline = await io.readJson(
            'load-baseline-report.json',
            RUNTIME_LIMITS.reportBytes
        );
        need(same(prior.baseline, baseline), 'LOAD_RUNTIME_PILOT_GATE');
    }
    const directories = {};
    for (const child of CHILDREN)
        directories[child] = await io.ensureDirectory(
            child,
            context.mode === 'pilot'
        );
    if (prior) {
        const resource = await io.readJson(
            'load-resource-observations/resources-pilot-summary.json',
            32768
        );
        need(
            resource.kind === 'INDEPENDENT_RESOURCE_SAMPLES' &&
                resource.runId === context.runId &&
                resource.phase === 'pilot' &&
                resource.collectionId ===
                    prior.collections.pilot.collectionId &&
                resource.evidenceKind ===
                    (evidenceKind === 'LIVE_NATIVE_ISOLATED'
                        ? 'LIVE_READ_ONLY'
                        : 'SYNTHETIC_UNIT_TEST') &&
                resource.oom === false &&
                resource.processLost === false &&
                resource.safetyReserveBreached === false,
            'LOAD_RUNTIME_PILOT_GATE'
        );
        for (const key of [
            'minimumFreeBytes',
            'peakMemoryBytes',
            'modelWarmState',
            'samples',
            'durationMs',
            'resourcePolicySha256',
        ])
            need(
                same(resource[key], prior.pilotObservation[key]),
                'LOAD_RUNTIME_PILOT_GATE'
            );
        for (const moment of ['BEFORE', 'AFTER']) {
            const receipt = await io.readJson(
                'store-sizes/store-sizes-pilot-' +
                    moment.toLowerCase() +
                    '.json',
                SIZE_LIMITS.receiptBytes
            );
            checkSizes(
                receipt,
                context,
                'pilot',
                moment,
                evidenceKind,
                moment === 'BEFORE'
                    ? null
                    : prior.collections.pilot.collectionId
            );
            need(
                same(receipt, prior.storeSizes?.[moment.toLowerCase()]),
                'LOAD_RUNTIME_PILOT_GATE'
            );
        }
    }
    const invocation = {
        schemaVersion: 1,
        namespace: context.state.namespace,
        runId: context.runId,
        workflow: context.mode,
        status: 'ADMITTED',
        evidenceKind,
        resourcePolicySha256: loadResourcePolicyHash(context.state),
        runtimeSha256: context.state.loadProcess.entrySha256,
    };
    await io.writeJson(
        names.invocation,
        invocation,
        true,
        RUNTIME_LIMITS.journalBytes
    );
    let services = null,
        report = null,
        failure = null,
        failureStage = 'CREATE_SERVICES';
    const first = new Set();
    const checkpoint = (workflow) => async (value) => {
        need(
            value.workflow === workflow &&
                value.runId === context.runId &&
                value.namespace === context.state.namespace &&
                value.evidenceKind === evidenceKind,
            'LOAD_RUNTIME_REPORT'
        );
        await guarded();
        const filename =
            workflow === 'baseline'
                ? 'load-baseline-journal.json'
                : names.journal;
        await io.writeJson(
            filename,
            value,
            !first.has(filename),
            RUNTIME_LIMITS.journalBytes
        );
        first.add(filename);
    };
    try {
        await guarded();
        services = await createServices({ context, directories, content });
        need(
            [
                services?.api?.signIn,
                services?.api?.call,
                services?.observer?.beginIndexObservation,
                services?.observer?.observeGeneration,
                services?.beginMeasurements,
                services?.observeStoreSizes,
                services?.assertSafe,
                services?.close,
            ].every((fn) => typeof fn === 'function'),
            'LOAD_RUNTIME_ADAPTER'
        );
        services.assertSafe();
        await guarded();
        services.assertSafe();
        failureStage = 'AUTHENTICATE';
        await services.api.signIn();
        const api = {
            call: async (...args) => {
                services.assertSafe();
                await guarded();
                services.assertSafe();
                const value = await services.api.call(...args);
                services.assertSafe();
                return value;
            },
        };
        const options = {
            state: context.state,
            fixture: context.fixture,
            ...content,
            api,
            now,
            sleep,
            evidenceKind,
            beginIndexObservation: (request) => {
                services.assertSafe();
                return services.observer.beginIndexObservation(request);
            },
            observeGeneration: (request) => {
                services.assertSafe();
                return services.observer.observeGeneration(request);
            },
            beginMeasurements: (request) => {
                services.assertSafe();
                return services.beginMeasurements(request);
            },
        };
        if (context.mode === 'pilot') {
            failureStage = 'PREPARE_BASELINE';
            const baseline = await protocols.prepareLoadBaseline({
                ...options,
                checkpoint: checkpoint('baseline'),
            });
            checkReport(baseline, context, 'baseline', evidenceKind);
            services.assertSafe();
            await guarded();
            failureStage = 'WRITE_BASELINE_REPORT';
            await io.writeJson(
                'load-baseline-report.json',
                baseline,
                true,
                RUNTIME_LIMITS.reportBytes
            );
            failureStage = 'MEASURE_BEFORE';
            const before = checkSizes(
                await services.observeStoreSizes({
                    runId: context.runId,
                    phase: 'pilot',
                    moment: 'BEFORE',
                    collectionId: null,
                }),
                context,
                'pilot',
                'BEFORE',
                evidenceKind
            );
            failureStage = 'IMPORT_PILOT';
            report = await protocols.importLoadPilot({
                ...options,
                baselineReport: baseline,
                checkpoint: checkpoint('pilot'),
            });
            checkReport(report, context, 'pilot', evidenceKind);
            failureStage = 'MEASURE_AFTER';
            const after = checkSizes(
                await services.observeStoreSizes({
                    runId: context.runId,
                    phase: 'pilot',
                    moment: 'AFTER',
                    collectionId: report.collections.pilot.collectionId,
                }),
                context,
                'pilot',
                'AFTER',
                evidenceKind,
                report.collections.pilot.collectionId
            );
            report = {
                ...report,
                storeSizes: {
                    scope: 'WHOLE_ISOLATED_STORES_INCLUDES_BASELINE_AND_OVERHEAD',
                    before,
                    after,
                },
            };
        } else {
            failureStage = 'MEASURE_BEFORE';
            const before = checkSizes(
                await services.observeStoreSizes({
                    runId: context.runId,
                    phase: 'full',
                    moment: 'BEFORE',
                    collectionId: null,
                }),
                context,
                'full',
                'BEFORE',
                evidenceKind
            );
            failureStage = 'IMPORT_FULL';
            report = await protocols.importLoadFull({
                ...options,
                pilotReport: prior,
                checkpoint: checkpoint('full'),
            });
            checkReport(report, context, 'full', evidenceKind);
            failureStage = 'MEASURE_AFTER';
            const after = checkSizes(
                await services.observeStoreSizes({
                    runId: context.runId,
                    phase: 'full',
                    moment: 'AFTER',
                    collectionId: report.collections.primary.collectionId,
                }),
                context,
                'full',
                'AFTER',
                evidenceKind,
                report.collections.primary.collectionId
            );
            report = {
                ...report,
                storeSizes: {
                    scope: 'WHOLE_ISOLATED_STORES_INCLUDES_BASELINE_AND_OVERHEAD',
                    before,
                    after,
                },
            };
        }
        failureStage = 'FINAL_GUARD';
        services.assertSafe();
        await guarded();
    } catch (error) {
        failure = safeFailure(error, failureStage);
    } finally {
        if (services)
            try {
                await services.close();
            } catch {
                failure ??= safeFailure(
                    new LoadRuntimeError('LOAD_RUNTIME_CLOSE_FAILED'),
                    'CLOSE_SERVICES'
                );
            }
    }
    if (!failure)
        try {
            failureStage = 'WRITE_REPORT';
            await guarded();
            await io.writeJson(
                names.report,
                report,
                true,
                RUNTIME_LIMITS.reportBytes
            );
        } catch (error) {
            failure = safeFailure(error, failureStage);
        }
    const outcome = failure
        ? {
              schemaVersion: 1,
              completed: false,
              status: 'INCOMPLETE',
              runId: context.runId,
              workflow: context.mode,
              evidenceKind,
              diagnostic: failure.code,
              failureStage: failure.failureStage,
              adapter: failure.adapter,
              acceptance: failure.acceptance,
              capacityAcceptance: 'NOT_RUN',
              trafficAcceptance: 'NOT_RUN',
          }
        : summaryFor(report);
    try {
        await io.writeJson(
            names.outcome,
            outcome,
            true,
            RUNTIME_LIMITS.journalBytes
        );
    } catch {
        throw safeFailure(
            new LoadRuntimeError('LOAD_RUNTIME_PRIVATE'),
            'WRITE_OUTCOME'
        );
    }
    if (failure) throw failure;
    return { report, summary: outcome };
}
/** Every injected failure is converted to a finite safe diagnostic, including preflight/file failures. */
export async function executeLoadImportWorkflow(options) {
    try {
        return await executeLoadImportWorkflowChecked(options);
    } catch (error) {
        throw safeFailure(error, 'PREFLIGHT');
    }
}
/** The entry validates explicit arguments before private-file reads, SDK imports or ownership subprocesses. */
export async function runLoadImportCli(args = process.argv.slice(2)) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_RUNTIME_DISABLED');
    const parsed = parseLoadImportArgs(args);
    const {
        discoverWorkspace,
        privateDirectory,
        readPrivate,
        privateCheckpoint,
    } = await import('./load-private.mjs');
    const root = discoverWorkspace(HERE),
        runDirectory = path.dirname(parsed.statePath);
    need(
        ['DEFAULT_V1', 'LIGHT_V1'].some(
            (id) =>
                parsed.statePath ===
                path.join(
                    root,
                    'node_modules/.cache/vectorix',
                    getLoadPolicy(id).namespace + '-' + parsed.runId,
                    'state.json'
                )
        ),
        'LOAD_RUNTIME_ARGUMENTS'
    );
    privateDirectory(runDirectory);
    const state = JSON.parse(
        readPrivate(parsed.statePath, RUNTIME_LIMITS.stateBytes)
    );
    const fixture = JSON.parse(
        readPrivate(
            path.join(runDirectory, 'fixture.json'),
            RUNTIME_LIMITS.fixtureBytes
        )
    );
    const context = validateLoadRuntimeContext({
        ...parsed,
        state,
        fixture,
        root,
        helperDirectory: HERE,
    });
    const { loadObserverGuard } = await import('./load-observer-runtime.mjs');
    const admit = createLoadImportAdmission({
        state,
        statePath: parsed.statePath,
        guard: loadObserverGuard,
    });
    await admit();
    for (const key of Object.keys(process.env))
        if (!['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key))
            delete process.env[key];
    const { loadRuntimeContent } =
        await import('./load-import-runtime-content.mjs');
    const content = await loadRuntimeContent({
        root,
        helperDirectory: HERE,
        state,
        admit,
    });
    return executeLoadImportWorkflow({
        context,
        io: createLoadRuntimeFiles(runDirectory, {
            privateDirectory,
            readPrivate,
            privateCheckpoint,
        }),
        content,
        admit,
        now: () => Math.floor(performance.now()),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        evidenceKind: 'LIVE_NATIVE_ISOLATED',
        createServices: ({ directories, content }) =>
            createLoadRuntimeServices({
                state,
                fixture,
                statePath: parsed.statePath,
                runDirectory,
                readCanonical: content.readCanonical,
                referenceMetadataFields:
                    content.references.manifest.metadataFields,
            }),
    });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    runLoadImportCli()
        .then(({ summary }) => console.log(JSON.stringify(summary)))
        .catch((error) => {
            const safe = safeFailure(error, 'PREFLIGHT');
            console.error(
                JSON.stringify({
                    completed: false,
                    status: 'NOT_RUN_OR_INCOMPLETE',
                    diagnostic: safe.code,
                    failureStage: safe.failureStage,
                    adapter: safe.adapter,
                    acceptance: safe.acceptance,
                    capacityAcceptance: 'NOT_RUN',
                })
            );
            process.exitCode = 1;
        });
