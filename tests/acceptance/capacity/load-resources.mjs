/** Bounded injected sampler. No process, filesystem, timer or service is touched on import. */
import { loadResourcePolicyHash } from './load-import-core.mjs';
import {
    need,
    digest,
    same,
    LoadObservationError,
} from './load-observer-core.mjs';
export const RUNTIME_DRAFT_ONLY = true;
export const RESOURCE_LIMITS = Object.freeze({
    minimumIntervalMs: 1000,
    maximumSamples: 20000,
    maximumBytes: 32 * 1024 ** 2,
    maximumSampleBytes: 4096,
});
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
/** No estimated peak: preserve each observed point, identities, actual gaps and monotonically counted CPU. */
export function resourceSummary(
    samples,
    {
        state,
        phase,
        collectionId,
        modelWarmState = 'UNKNOWN',
        evidenceKind = 'LIVE_READ_ONLY',
    }
) {
    need(
        Array.isArray(samples) &&
            samples.length >= 2 &&
            samples.length <= RESOURCE_LIMITS.maximumSamples,
        'LOAD_OBS_RESOURCE_COUNT'
    );
    need(
        ['pilot', 'full'].includes(phase) &&
            ['WARM', 'COLD', 'UNKNOWN'].includes(modelWarmState),
        'LOAD_OBS_RESOURCE_SCOPE'
    );
    const first = samples[0];
    let previous = null,
        maximumGapMs = 0,
        peakMemoryBytes = 0,
        minimumFreeBytes = Number.MAX_SAFE_INTEGER;
    const identities = (value) => ({
        processes: value.processes.map(({ service, pid, startTicks }) => ({
            service,
            pid,
            startTicks,
        })),
        containers: value.containers.map(({ service, id, restarts }) => ({
            service,
            id,
            restarts,
        })),
    });
    for (const sample of samples) {
        need(
            nonnegative(sample.atMs) &&
                nonnegative(sample.freeBytes) &&
                Array.isArray(sample.processes) &&
                sample.processes.length >= 3 &&
                sample.processes.length <= 4 &&
                Array.isArray(sample.containers) &&
                sample.containers.length === 5 &&
                sample.progress &&
                Object.keys(sample.progress).sort().join(',') ===
                    'activeChildren,completedTasks,materializedChildren,pendingTasks' &&
                Object.values(sample.progress).every(nonnegative),
            'LOAD_OBS_RESOURCE_SAMPLE'
        );
        need(
            same(identities(first), identities(sample)) &&
                new Set(sample.processes.map((row) => row.service)).size ===
                    sample.processes.length &&
                new Set(sample.containers.map((row) => row.service)).size === 5,
            'LOAD_OBS_RESOURCE_IDENTITY'
        );
        let memory = 0;
        for (const row of [...sample.processes, ...sample.containers]) {
            need(
                nonnegative(row.cpuMicros) && nonnegative(row.memoryBytes),
                'LOAD_OBS_RESOURCE_SAMPLE'
            );
            memory += row.memoryBytes;
        }
        need(
            Number.isSafeInteger(memory) &&
                memory > 0 &&
                sample.processes.every((row) => row.alive === true) &&
                sample.containers.every(
                    (row) =>
                        row.running === true &&
                        row.oomKilled === false &&
                        row.oomKillCount === 0
                ),
            'LOAD_OBS_RESOURCE_UNSAFE'
        );
        need(
            sample.freeBytes >= state.loadPolicy.minimumFreeBytes,
            'LOAD_OBS_RESOURCE_DISK'
        );
        if (previous) {
            const gap = sample.atMs - previous.atMs;
            need(
                gap >= RESOURCE_LIMITS.minimumIntervalMs,
                'LOAD_OBS_RESOURCE_INTERVAL'
            );
            maximumGapMs = Math.max(maximumGapMs, gap);
            for (const key of ['processes', 'containers'])
                sample[key].forEach((row, index) =>
                    need(
                        row.cpuMicros >= previous[key][index].cpuMicros,
                        'LOAD_OBS_RESOURCE_RESET'
                    )
                );
        }
        previous = sample;
        peakMemoryBytes = Math.max(peakMemoryBytes, memory);
        minimumFreeBytes = Math.min(minimumFreeBytes, sample.freeBytes);
    }
    return {
        schemaVersion: 1,
        kind: 'INDEPENDENT_RESOURCE_SAMPLES',
        evidenceKind,
        runId: state.runId,
        phase,
        collectionId,
        samples: samples.length,
        durationMs: samples.at(-1).atMs - first.atMs,
        minimumFreeBytes,
        peakMemoryBytes,
        modelWarmState,
        resourcePolicySha256: loadResourcePolicyHash(state),
        oom: false,
        processLost: false,
        safetyReserveBreached: false,
        observedCPUMicros: [
            ...samples.at(-1).processes,
            ...samples.at(-1).containers,
        ].reduce(
            (sum, row, index) =>
                sum +
                row.cpuMicros -
                [...first.processes, ...first.containers][index].cpuMicros,
            0
        ),
        maximumSampleGapMs: maximumGapMs,
        samplesSha256: digest(samples),
        memoryDefinition:
            'SUM_PROCESS_RSS_PLUS_CONTAINER_CGROUP_CURRENT_INCLUDES_CACHE_AND_SHARED_PAGES',
        peakDefinition: 'MAX_RECORDED_POINTS_NOT_CONTINUOUS_PEAK',
    };
}
/** Timer callbacks only schedule after the previous sample; never overlap reads or make up missed points. */
export function createResourceMeasurements({
    state,
    admit,
    readSample,
    writer,
    now,
    sleep,
    schedule = setTimeout,
    cancel = clearTimeout,
    onUnsafe = () => {},
}) {
    need(
        [
            admit,
            readSample,
            writer?.begin,
            writer?.append,
            writer?.finish,
            now,
            sleep,
            schedule,
            cancel,
            onUnsafe,
        ].every((fn) => typeof fn === 'function'),
        'LOAD_OBS_RESOURCE_ADAPTER'
    );
    let active = false;
    return async function beginMeasurements(input) {
        need(
            !active &&
                input.runId === state.runId &&
                ['pilot', 'full'].includes(input.phase) &&
                /^[A-Za-z0-9_-]{1,128}$/u.test(input.collectionId),
            'LOAD_OBS_RESOURCE_SCOPE'
        );
        active = true;
        let samples = [],
            bytes = 0,
            timer = null,
            pending = null,
            stopped = false,
            failed = null,
            finished = false;
        try {
            await admit();
            await writer.begin(input);
        } catch (error) {
            active = false;
            await writer.abort?.();
            throw error;
        }
        const unsafe = (error) => {
            failed =
                error instanceof LoadObservationError
                    ? error
                    : new LoadObservationError('LOAD_OBS_RESOURCE_READ');
            stopped = true;
            try {
                const result = onUnsafe(failed);
                if (result && typeof result.then === 'function')
                    Promise.resolve(result).catch(() => {});
            } catch {
                /* Original refusal remains decisive. */
            }
        };
        // A Node timer may wake before the requested real interval. Both scheduled
        // and final captures share the same absolute sample target; never weaken
        // resourceSummary's actual minimum gap or fabricate a later timestamp.
        const waitForSampleWindow = async () => {
            if (!samples.length) return;
            const target =
                samples.at(-1).atMs + RESOURCE_LIMITS.minimumIntervalMs;
            let previous = now(),
                wakes = 0;
            need(Number.isFinite(previous), 'LOAD_OBS_RESOURCE_INTERVAL');
            while (previous < target) {
                need(++wakes <= 64, 'LOAD_OBS_RESOURCE_INTERVAL');
                await sleep(Math.ceil(target - previous));
                const current = now();
                need(
                    Number.isFinite(current) && current >= previous,
                    'LOAD_OBS_RESOURCE_INTERVAL'
                );
                previous = current;
                if (failed) throw failed;
            }
        };
        const capture = async () => {
            try {
                need(
                    !failed && samples.length < RESOURCE_LIMITS.maximumSamples,
                    'LOAD_OBS_RESOURCE_COUNT'
                );
                await waitForSampleWindow();
                if (samples.length % 30 === 0) await admit();
                const sample = await readSample(input),
                    encoded = JSON.stringify(sample) + '\n';
                need(
                    sample.atMs === Math.floor(sample.atMs) &&
                        Buffer.byteLength(encoded) <=
                            RESOURCE_LIMITS.maximumSampleBytes &&
                        bytes + Buffer.byteLength(encoded) <=
                            RESOURCE_LIMITS.maximumBytes,
                    'LOAD_OBS_RESOURCE_BYTES'
                );
                // A two-point prefix validates immediately; first point also receives finite safety validation.
                need(
                    sample.freeBytes >= state.loadPolicy.minimumFreeBytes &&
                        sample.processes.every((row) => row.alive === true) &&
                        sample.containers.every(
                            (row) =>
                                row.running === true &&
                                row.oomKilled === false &&
                                row.oomKillCount === 0
                        ),
                    'LOAD_OBS_RESOURCE_UNSAFE'
                );
                if (samples.length)
                    resourceSummary([samples.at(-1), sample], {
                        state,
                        ...input,
                    });
                await writer.append(sample);
                samples.push(sample);
                bytes += Buffer.byteLength(encoded);
            } catch (error) {
                unsafe(error);
            }
        };
        const tick = () => {
            pending = capture().then(() => {
                pending = null;
                if (!stopped)
                    timer = schedule(tick, RESOURCE_LIMITS.minimumIntervalMs);
            });
        };
        pending = capture();
        await pending;
        pending = null;
        if (failed) {
            active = false;
            await writer.abort?.();
            throw failed;
        }
        timer = schedule(tick, RESOURCE_LIMITS.minimumIntervalMs);
        return {
            assertSafe() {
                if (failed) throw failed;
            },
            async finish() {
                need(!finished, 'LOAD_OBS_RESOURCE_FINISHED');
                finished = true;
                stopped = true;
                if (timer !== null) cancel(timer);
                try {
                    if (pending) await pending;
                    if (failed) throw failed;
                    await capture();
                    if (failed) throw failed;
                    await admit();
                    const result = resourceSummary(samples, {
                        state,
                        ...input,
                    });
                    await writer.finish(result);
                    return result;
                } finally {
                    active = false;
                    samples = [];
                    await writer.abort?.();
                }
            },
        };
    };
}
