/** Explicit traffic wrapper; frozen pilot/full sampler primitives remain unchanged. */
import { Worker } from 'node:worker_threads';
import { need, digest } from './load-observer-core.mjs';
import { checkedWorkerSummary } from './load-traffic-resource-worker.mjs';
export const STATIC_DRAFT_ONLY = false;
/** Separate directories keep internal primitive filenames isolated; outer reports state their actual traffic phase. */
export function wrapTrafficMeasurement(begin, phase, persist) {
    need(
        ['paced', 'closed-loop'].includes(phase) &&
            typeof begin === 'function' &&
            typeof persist === 'function',
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    return async (request) => {
        need(request.phase === phase, 'LOAD_OBS_TRAFFIC_RESOURCE');
        const inner = await begin({ ...request, phase: 'full' });
        return {
            assertSafe: () => inner.assertSafe(),
            async finish() {
                const raw = await inner.finish(),
                    result = {
                        ...raw,
                        phase,
                        measurementPurpose: 'TRAFFIC',
                        rawPrimitivePhaseTag: raw.phase,
                        rawSummarySha256: digest(raw),
                    };
                await persist(result);
                return result;
            },
        };
    };
}
export async function createTrafficResourceRuntime({
    state,
    fixture,
    statePath,
    phase,
    directory,
    onUnsafe,
    persist,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    need(
        fixture?.runId === state.runId && typeof onUnsafe === 'function',
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    return trafficWorkerMeasurements({
        phase,
        onUnsafe,
        persist,
        workerFactory: () =>
            new Worker(
                new URL('./load-traffic-resource-worker.mjs', import.meta.url),
                {
                    workerData: {
                        statePath,
                        directory,
                        runId: state.runId,
                        phase,
                    },
                }
            ),
    });
}
/** Pure injected message protocol; tests never construct an actual thread or touch process resources. */
export function trafficWorkerMeasurements({
    phase,
    onUnsafe,
    persist,
    workerFactory,
    timeoutMs = 120000,
}) {
    need(
        Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000,
        'LOAD_OBS_TRAFFIC_RESOURCE'
    );
    let used = false;
    return async (input) => {
        need(!used && input.phase === phase, 'LOAD_OBS_TRAFFIC_RESOURCE');
        used = true;
        const worker = workerFactory(),
            waiting = new Map();
        let failed = false,
            started = false,
            finishing = false,
            disposed = false;
        const fail = () => {
            failed = true;
            try {
                onUnsafe();
            } catch {}
            for (const value of waiting.values()) {
                clearTimeout(value.timer);
                value.reject(new Error('LOAD_OBS_TRAFFIC_RESOURCE'));
            }
            waiting.clear();
            if (!disposed) {
                disposed = true;
                try {
                    Promise.resolve(worker.terminate()).catch(() => {});
                } catch {}
                worker.unref?.();
            }
        };
        const receive = (value) => {
            let bytes;
            try {
                bytes = Buffer.byteLength(JSON.stringify(value));
            } catch {
                fail();
                return;
            }
            if (
                !value ||
                bytes > 16384 ||
                !['READY', 'STARTED', 'FINISHED', 'UNSAFE', 'FAILED'].includes(
                    value.type
                )
            ) {
                fail();
                return;
            }
            if (value.type === 'UNSAFE' || value.type === 'FAILED') {
                fail();
                return;
            }
            const next = waiting.get(value.type);
            if (!next) {
                fail();
                return;
            }
            waiting.delete(value.type);
            clearTimeout(next.timer);
            next.resolve(value);
        };
        worker.on('message', receive);
        worker.on('error', fail);
        worker.on('exit', (code) => {
            if (code !== 0 || waiting.size) fail();
        });
        const wait = (type) =>
            new Promise((resolve, reject) => {
                need(
                    !failed && !waiting.has(type),
                    'LOAD_OBS_TRAFFIC_RESOURCE'
                );
                const timer = setTimeout(() => {
                    fail();
                }, timeoutMs);
                waiting.set(type, { resolve, reject, timer });
            });
        await wait('READY');
        const start = wait('STARTED');
        worker.postMessage({ type: 'START', input });
        await start;
        started = true;
        return {
            assertSafe: () => need(!failed, 'LOAD_OBS_TRAFFIC_RESOURCE'),
            async finish() {
                try {
                    need(!failed && !finishing, 'LOAD_OBS_TRAFFIC_RESOURCE');
                    finishing = true;
                    const complete = wait('FINISHED');
                    worker.postMessage({ type: 'FINISH', input: null });
                    const message = await complete,
                        raw = checkedWorkerSummary(message.summary),
                        harness = message.harness;
                    const keys = [
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
                        'definition',
                    ];
                    need(
                        raw.runId === input.runId &&
                            raw.collectionId === input.collectionId &&
                            harness &&
                            Object.keys(harness).sort().join(',') ===
                                keys.sort().join(',') &&
                            keys
                                .filter((key) => key !== 'definition')
                                .every(
                                    (key) =>
                                        Number.isSafeInteger(harness[key]) &&
                                        harness[key] >= 0
                                ) &&
                            harness.definition ===
                                'MEASURED_THREAD_ADMISSION_AND_PROGRESS_COMPONENTS_NOT_EVERY_INTERNAL_SAMPLE_COMPONENT',
                        'LOAD_OBS_TRAFFIC_RESOURCE'
                    );
                    const result = {
                        ...raw,
                        phase,
                        measurementPurpose: 'TRAFFIC',
                        rawPrimitivePhaseTag: raw.phase,
                        rawSummarySha256: digest(raw),
                        samplerThread: harness,
                    };
                    await persist(result);
                    return result;
                } catch {
                    fail();
                    throw new Error('LOAD_OBS_TRAFFIC_RESOURCE');
                }
            },
        };
    };
}
