/** Injected clocks, numeric process snapshots and pure Linux-stat parsing only. No actual process is inspected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resourceSummary,
    createResourceMeasurements,
} from './load-resources.mjs';
import {
    linuxProcessSample,
    createLoadResourceRuntime,
    STATIC_DRAFT_ONLY,
} from './load-resources-runtime.mjs';
const state = {
    runId: '0123456789ab',
    commit: 'a'.repeat(40),
    images: { postgres: 'sha256:' + 'b'.repeat(64) },
    resourceLimits: {},
    loadPolicy: { minimumFreeBytes: 4 * 1024 ** 3 },
};
const input = {
    runId: state.runId,
    phase: 'pilot',
    collectionId: 'collection',
};
const sample = (atMs) => ({
    atMs,
    freeBytes: 5 * 1024 ** 3,
    processes: ['api', 'workers', 'load'].map((service, index) => ({
        service,
        pid: index + 100,
        startTicks: String(index),
        alive: true,
        cpuMicros: atMs + 100,
        memoryBytes: 1000,
    })),
    containers: ['postgres', 'vector', 'redis', 'rustfs', 'ollama'].map(
        (service, index) => ({
            service,
            id: String(index).repeat(64),
            running: true,
            oomKilled: false,
            restarts: 0,
            oomKillCount: 0,
            cpuMicros: atMs + 100,
            memoryBytes: 1000,
        })
    ),
    progress: {
        activeChildren: 0,
        materializedChildren: 0,
        pendingTasks: 0,
        completedTasks: 0,
    },
});
test('summary reports actual observed points/gaps/CPU and explicitly does not claim continuous memory peaks', () => {
    const result = resourceSummary([sample(0), sample(1500), sample(4500)], {
        state,
        ...input,
    });
    assert.equal(result.samples, 3);
    assert.equal(result.maximumSampleGapMs, 3000);
    assert.equal(result.peakMemoryBytes, 8000);
    assert.equal(result.observedCPUMicros, 36000);
    assert.equal(result.durationMs, 4500);
    assert.equal(result.modelWarmState, 'UNKNOWN');
    assert.equal(
        result.peakDefinition,
        'MAX_RECORDED_POINTS_NOT_CONTINUOUS_PEAK'
    );
});
test('OOM, restarted/replaced process, low disk, CPU reset and impossible interval all fail instead of invented safe peaks', () => {
    for (const change of [
        (value) => (value.containers[0].oomKilled = true),
        (value) => (value.containers[0].oomKillCount = 1),
        (value) => (value.containers[0].restarts = 1),
        (value) => (value.processes[0].startTicks = 'changed'),
        (value) => (value.processes[0].alive = false),
        (value) => (value.freeBytes = 3 * 1024 ** 3),
        (value) => (value.processes[0].cpuMicros = 0),
        (value) => (value.atMs = 500),
    ]) {
        const value = sample(1000);
        change(value);
        assert.throws(() =>
            resourceSummary([sample(0), value], { state, ...input })
        );
    }
    assert.throws(
        () => resourceSummary(new Array(20001), { state, ...input }),
        { code: 'LOAD_OBS_RESOURCE_COUNT' }
    );
});
test('sampler owns one phase, records first/final points, no overlapping timers, and refuses reused finish', async () => {
    let time = 0,
        callback = null,
        writes = [],
        summary = null,
        guard = 0,
        aborts = 0;
    const begin = createResourceMeasurements({
        state,
        admit: async () => guard++,
        readSample: async () => sample(time),
        writer: {
            begin: async () => {},
            append: async (value) => writes.push(value),
            finish: async (value) => (summary = value),
            abort: async () => aborts++,
        },
        now: () => time,
        sleep: async (ms) => (time += ms),
        schedule: (fn) => {
            callback = fn;
            return 1;
        },
        cancel: () => {
            callback = null;
        },
    });
    const measurement = await begin(input);
    assert.equal(writes.length, 1);
    await assert.rejects(() => begin(input), {
        code: 'LOAD_OBS_RESOURCE_SCOPE',
    });
    time = 1000;
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 2);
    const result = await measurement.finish();
    assert.equal(result.samples, 3);
    assert.equal(summary, result);
    assert.equal(aborts, 1);
    assert(guard >= 2);
    await assert.rejects(() => measurement.finish(), {
        code: 'LOAD_OBS_RESOURCE_FINISHED',
    });
});
test('safety refusal stops new samples, calls onUnsafe, closes private writer and produces no successful summary', async () => {
    let time = 0,
        callback,
        unsafe = 0,
        closed = 0,
        finished = 0;
    const begin = createResourceMeasurements({
        state,
        admit: async () => {},
        readSample: async () => ({
            ...sample(time),
            freeBytes: time ? 0 : 5 * 1024 ** 3,
        }),
        writer: {
            begin: async () => {},
            append: async () => {},
            finish: async () => finished++,
            abort: async () => closed++,
        },
        now: () => time,
        sleep: async (ms) => (time += ms),
        schedule: (fn) => {
            callback = fn;
            return 1;
        },
        cancel: () => {},
        onUnsafe: () => unsafe++,
    });
    const measurement = await begin(input);
    time = 1000;
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unsafe, 1);
    assert.throws(() => measurement.assertSafe());
    await assert.rejects(() => measurement.finish());
    assert.equal(finished, 0);
    assert.equal(closed, 1);
});
test('first-write/admission error does not leave an occupied measurement slot', async () => {
    let failed = true;
    const begin = createResourceMeasurements({
        state,
        admit: async () => {
            if (failed) throw new Error('synthetic');
        },
        readSample: async () => sample(0),
        writer: {
            begin: async () => {},
            append: async () => {},
            finish: async () => {},
            abort: async () => {},
        },
        now: () => 0,
        sleep: async () => {},
        schedule: () => 1,
        cancel: () => {},
    });
    await assert.rejects(() => begin(input));
    failed = false;
    const measurement = await begin(input);
    assert(measurement); // No real timer was scheduled.
});
test('Linux process parser preserves real RSS ticks and rejects zombie/reused PID without reading procfs', () => {
    const fields = new Array(24).fill('0');
    fields[0] = 'S';
    fields[11] = '200';
    fields[12] = '100';
    fields[19] = '123';
    fields[21] = '40';
    const parsed = linuxProcessSample(
        '501 (some command) ' + fields.join(' '),
        {
            pid: 501,
            startTicks: '123',
            service: 'workers',
            hz: 100,
            pageSize: 4096,
        }
    );
    assert.equal(parsed.cpuMicros, 3000000);
    assert.equal(parsed.memoryBytes, 163840);
    fields[0] = 'Z';
    assert.throws(() =>
        linuxProcessSample('501 (some command) ' + fields.join(' '), {
            pid: 501,
            startTicks: '123',
            service: 'workers',
            hz: 100,
            pageSize: 4096,
        })
    );
});
test('real sampler refuses disabled or malformed state before filesystem/process access', async () => {
    await assert.rejects(() => createLoadResourceRuntime({ state: null }), {
        code: STATIC_DRAFT_ONLY
            ? 'LOAD_OBS_RUNTIME_DISABLED'
            : 'LOAD_OBS_SCOPE',
    });
});
test('early scheduled and final timer wakes wait for the actual unchanged minimum interval', async () => {
    let time = 0,
        callback,
        unsafe = 0;
    const writes = [],
        sleeps = [],
        advances = [0.25, 0.25, 999.5, 0.5];
    const begin = createResourceMeasurements({
        state,
        admit: async () => {},
        readSample: async () => sample(Math.floor(time)),
        writer: {
            begin: async () => {},
            append: async (value) => writes.push(value),
            finish: async () => {},
            abort: async () => {},
        },
        now: () => time,
        sleep: async (ms) => {
            sleeps.push(ms);
            time += advances.shift() ?? ms;
        },
        schedule: (fn) => {
            callback = fn;
            return 1;
        },
        cancel: () => {
            callback = null;
        },
        onUnsafe: () => unsafe++,
    });
    const measurement = await begin(input);
    time = 999.5;
    callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
        writes.map((value) => value.atMs),
        [0, 1000]
    );
    const result = await measurement.finish();
    assert.deepEqual(
        writes.map((value) => value.atMs),
        [0, 1000, 2000]
    );
    assert.deepEqual(sleeps, [1, 1, 1000, 1]);
    assert.equal(result.maximumSampleGapMs, 1000);
    assert.equal(result.durationMs, 2000);
    assert.equal(unsafe, 0);
});
test('nonadvancing or backwards injected clocks cannot loop forever or invent safe resource samples', async () => {
    for (const backwards of [false, true]) {
        let time = 0,
            callback,
            sleeps = 0,
            unsafe = 0,
            reads = 0;
        const begin = createResourceMeasurements({
            state,
            admit: async () => {},
            readSample: async () => {
                reads++;
                return sample(time);
            },
            writer: {
                begin: async () => {},
                append: async () => {},
                finish: async () => {},
                abort: async () => {},
            },
            now: () => time,
            sleep: async () => {
                sleeps++;
                if (backwards) time--;
            },
            schedule: (fn) => {
                callback = fn;
                return 1;
            },
            cancel: () => {},
            onUnsafe: () => unsafe++,
        });
        const measurement = await begin(input);
        callback();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(reads, 1);
        assert.equal(unsafe, 1);
        assert.equal(sleeps, backwards ? 1 : 64);
        await assert.rejects(() => measurement.finish(), {
            code: 'LOAD_OBS_RESOURCE_INTERVAL',
        });
    }
});
