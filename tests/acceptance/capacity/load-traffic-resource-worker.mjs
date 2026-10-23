/** Guarded same-PID sampler thread. Synchronous reviewed Docker/PG sampling never occupies the traffic scheduler. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { need, same, validateIdentity, hash } from './load-observer-core.mjs';
import { privateDirectory, readPrivate } from './load-private.mjs';
import {
    loadObserverGuard,
    loadObservationPackages,
} from './load-observer-runtime.mjs';
import { readProgressSnapshot } from './load-observer-sql.mjs';
import { createLoadResourceRuntime } from './load-resources-runtime.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url)),
    ROOT = path.resolve(HERE, '../../..');
const now = () => Math.round(performance.now() * 1000);
/** Only numeric/digest sampler observations may cross back; no paths, environments, provider content or stacks. */
export function checkedWorkerSummary(value) {
    const names = [
        'schemaVersion',
        'kind',
        'evidenceKind',
        'runId',
        'phase',
        'collectionId',
        'samples',
        'durationMs',
        'minimumFreeBytes',
        'peakMemoryBytes',
        'modelWarmState',
        'resourcePolicySha256',
        'oom',
        'processLost',
        'safetyReserveBreached',
        'observedCPUMicros',
        'maximumSampleGapMs',
        'samplesSha256',
        'memoryDefinition',
        'peakDefinition',
    ];
    need(
        value &&
            same(Object.keys(value).sort(), names.sort()) &&
            value.schemaVersion === 1 &&
            value.kind === 'INDEPENDENT_RESOURCE_SAMPLES' &&
            value.evidenceKind === 'LIVE_READ_ONLY' &&
            /^[a-f0-9]{12}$/u.test(value.runId) &&
            value.phase === 'full' &&
            /^[A-Za-z0-9_-]{1,128}$/u.test(value.collectionId) &&
            hash(value.resourcePolicySha256) &&
            hash(value.samplesSha256) &&
            ['UNKNOWN', 'WARM', 'COLD'].includes(value.modelWarmState) &&
            value.oom === false &&
            value.processLost === false &&
            value.safetyReserveBreached === false &&
            [
                'samples',
                'durationMs',
                'minimumFreeBytes',
                'peakMemoryBytes',
                'observedCPUMicros',
                'maximumSampleGapMs',
            ].every(
                (key) => Number.isSafeInteger(value[key]) && value[key] >= 0
            ) &&
            value.samples >= 2 &&
            value.samples <= 20000 &&
            value.peakMemoryBytes > 0 &&
            value.memoryDefinition ===
                'SUM_PROCESS_RSS_PLUS_CONTAINER_CGROUP_CURRENT_INCLUDES_CACHE_AND_SHARED_PAGES' &&
            value.peakDefinition === 'MAX_RECORDED_POINTS_NOT_CONTINUOUS_PEAK',
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    return value;
}
async function run() {
    need(
        !STATIC_DRAFT_ONLY && !isMainThread && parentPort,
        'LOAD_OBS_RUNTIME_DISABLED'
    );
    need(
        workerData &&
            Object.keys(workerData).sort().join(',') ===
                'directory,phase,runId,statePath' &&
            /^[a-f0-9]{12}$/u.test(workerData.runId) &&
            ['paced', 'closed-loop'].includes(workerData.phase),
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    const directory = path.join(
        ROOT,
        'node_modules/.cache/vectorix',
        'vectorix-m7c-load-' + workerData.runId
    );
    need(
        workerData.statePath === path.join(directory, 'state.json') &&
            workerData.directory ===
                path.join(directory, 'traffic-resources-' + workerData.phase),
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    privateDirectory(directory);
    privateDirectory(workerData.directory);
    const state = JSON.parse(
            readPrivate(workerData.statePath, 128 * 1024).toString('utf8')
        ),
        fixture = JSON.parse(
            readPrivate(
                path.join(directory, 'fixture.json'),
                128 * 1024
            ).toString('utf8')
        );
    validateIdentity(state, fixture);
    need(
        state.loadProcess?.pid === process.pid &&
            state.loadProcess.workflow === 'traffic',
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    let guards = 0,
        guardTotal = 0,
        guardMax = 0,
        progressCount = 0,
        progressTotal = 0,
        progressMax = 0;
    const guard = () => {
        const start = now();
        loadObserverGuard({ state, statePath: workerData.statePath });
        const elapsed = now() - start;
        guards++;
        guardTotal += elapsed;
        guardMax = Math.max(guardMax, elapsed);
    };
    const calibrationStart = now();
    guard();
    const calibrationGuardMicros = now() - calibrationStart;
    const { Client } = await loadObservationPackages(async () => guard());
    const readProgress = async (input) => {
        const started = now();
        guard();
        const client = new Client({
            connectionString: state.environment.DATABASE_URL,
            connectionTimeoutMillis: 5000,
            query_timeout: 12000,
        });
        try {
            await client.connect();
            return await readProgressSnapshot(client, {
                state,
                fixture,
                input,
            });
        } finally {
            await client.end().catch(() => {});
            const elapsed = now() - started;
            progressCount++;
            progressTotal += elapsed;
            progressMax = Math.max(progressMax, elapsed);
        }
    };
    const setup = now();
    const begin = await createLoadResourceRuntime({
        state,
        fixture,
        statePath: workerData.statePath,
        directory: workerData.directory,
        readProgress,
        onUnsafe: () =>
            parentPort.postMessage({
                type: 'UNSAFE',
                diagnostic: 'LOAD_TRAFFIC_RESOURCE_UNSAFE',
            }),
    });
    const factorySetupMicros = now() - setup;
    let measurement = null,
        starting = false,
        finished = false,
        firstSampleAndAdmissionMicros = 0;
    parentPort.on('message', (message) => {
        void (async () => {
            need(
                message &&
                    Object.keys(message).sort().join(',') === 'input,type' &&
                    ['START', 'FINISH'].includes(message.type),
                'LOAD_OBS_TRAFFIC_RESOURCE'
            );
            if (message.type === 'START') {
                need(
                    !starting &&
                        !measurement &&
                        !finished &&
                        message.input?.runId === state.runId &&
                        message.input.phase === workerData.phase,
                    'LOAD_OBS_TRAFFIC_RESOURCE'
                );
                starting = true;
                const start = now();
                measurement = await begin({ ...message.input, phase: 'full' });
                firstSampleAndAdmissionMicros = now() - start;
                parentPort.postMessage({ type: 'STARTED' });
            } else {
                need(
                    measurement && !finished && message.input === null,
                    'LOAD_OBS_TRAFFIC_RESOURCE'
                );
                finished = true;
                const start = now(),
                    summary = checkedWorkerSummary(await measurement.finish());
                const harness = {
                    calibrationGuardMicros,
                    factorySetupMicros,
                    firstSampleAndAdmissionMicros,
                    finishMicros: now() - start,
                    progressReads: progressCount,
                    progressTotalMicros: progressTotal,
                    progressMaximumMicros: progressMax,
                    explicitGuards: guards,
                    explicitGuardTotalMicros: guardTotal,
                    explicitGuardMaximumMicros: guardMax,
                    definition:
                        'MEASURED_THREAD_ADMISSION_AND_PROGRESS_COMPONENTS_NOT_EVERY_INTERNAL_SAMPLE_COMPONENT',
                };
                need(
                    Object.values(harness).every(
                        (value) =>
                            typeof value === 'string' ||
                            (Number.isSafeInteger(value) && value >= 0)
                    ),
                    'LOAD_OBS_TRAFFIC_RESOURCE'
                );
                parentPort.postMessage({ type: 'FINISHED', summary, harness });
                parentPort.close();
            }
        })().catch(async () => {
            try {
                if (measurement && !finished) await measurement.finish();
            } catch {}
            parentPort.postMessage({
                type: 'FAILED',
                diagnostic: 'LOAD_TRAFFIC_RESOURCE_FAILED',
            });
            parentPort.close();
        });
    });
    parentPort.postMessage({ type: 'READY' });
}
if (!isMainThread)
    void run().catch(() => {
        parentPort?.postMessage({
            type: 'FAILED',
            diagnostic: 'LOAD_TRAFFIC_RESOURCE_FAILED',
        });
        parentPort?.close();
    });
