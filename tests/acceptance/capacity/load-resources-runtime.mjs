/** Guarded Linux cgroup-v2 adapter. Import performs no filesystem, child, SDK or resource operation. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
    createResourceMeasurements,
    RESOURCE_LIMITS,
} from './load-resources.mjs';
import { loadObserverGuard } from './load-observer-runtime.mjs';
import {
    validateIdentity,
    need,
    LoadObservationError,
} from './load-observer-core.mjs';
import { privateDirectory, privateCheckpoint } from './load-private.mjs';
export const STATIC_DRAFT_ONLY = false;
const safeEnvironment = () =>
    Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]])
    );
const boundedText = (filename, maximum = 4096) => {
    const fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const buffer = Buffer.alloc(maximum + 1),
            size = fs.readSync(fd, buffer, 0, buffer.length, null);
        need(size <= maximum, 'LOAD_OBS_RESOURCE_BYTES');
        return buffer.subarray(0, size).toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
};
const integer = (value) => {
    need(/^(0|[1-9][0-9]*)$/u.test(value), 'LOAD_OBS_RESOURCE_NUMBER');
    const result = Number(value);
    need(Number.isSafeInteger(result), 'LOAD_OBS_RESOURCE_NUMBER');
    return result;
};
/** Parse Linux stat after the last command delimiter; CPU is cumulative and RSS is actual resident pages. */
export function linuxProcessSample(
    stat,
    { pid, startTicks, service, hz, pageSize }
) {
    need(
        stat.length <= 8192 && stat.startsWith(pid + ' ('),
        'LOAD_OBS_RESOURCE_PROCESS'
    );
    const parts = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u);
    need(
        parts.length >= 22 &&
            !['Z', 'X', 'x'].includes(parts[0]) &&
            parts[19] === startTicks,
        'LOAD_OBS_RESOURCE_PROCESS'
    );
    return {
        service,
        pid,
        startTicks,
        alive: true,
        cpuMicros: Math.round(
            ((integer(parts[11]) + integer(parts[12])) * 1e6) / hz
        ),
        memoryBytes: integer(parts[21]) * pageSize,
    };
}
function getconf(name) {
    const result = spawnSync('getconf', [name], {
        encoding: 'utf8',
        env: safeEnvironment(),
        timeout: 2000,
        maxBuffer: 128,
    });
    need(result.status === 0 && !result.error, 'LOAD_OBS_RESOURCE_PLATFORM');
    const value = integer(result.stdout.trim());
    need(value > 0 && value <= 1048576, 'LOAD_OBS_RESOURCE_PLATFORM');
    return value;
}
function cgroup(pid, id) {
    const line = boundedText('/proc/' + pid + '/cgroup')
        .trim()
        .split('\n');
    need(
        line.length === 1 && line[0].startsWith('0::/'),
        'LOAD_OBS_RESOURCE_CGROUP'
    );
    const relative = line[0].slice(3);
    need(
        !relative.split('/').includes('..') && relative.includes(id),
        'LOAD_OBS_RESOURCE_CGROUP'
    );
    const directory = path.resolve('/sys/fs/cgroup', '.' + relative);
    need(
        directory.startsWith('/sys/fs/cgroup/') &&
            fs.realpathSync(directory) === directory,
        'LOAD_OBS_RESOURCE_CGROUP'
    );
    return directory;
}
function keyed(text, key) {
    const rows = text
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/u)),
        found = rows.filter((row) => row[0] === key);
    need(
        found.length === 1 && found[0].length === 2,
        'LOAD_OBS_RESOURCE_CGROUP'
    );
    return integer(found[0][1]);
}
/** Captures only finite cgroup state, never raw docker inspection configuration or environment. */
function readLinuxResources({ state, directory, hz, pageSize, now, progress }) {
    const records = [
        ...Object.values(state.processes),
        ...Object.values(state.dashboardProcesses),
        state.loadProcess,
    ];
    need(
        records.length >= 3 && records.length <= 4 && records.every(Boolean),
        'LOAD_OBS_RESOURCE_PROCESS'
    );
    const processes = records.map((record) =>
        linuxProcessSample(boundedText('/proc/' + record.pid + '/stat', 8192), {
            ...record,
            hz,
            pageSize,
        })
    );
    const services = ['postgres', 'vector', 'redis', 'rustfs', 'ollama'],
        ids = services.map((service) => state.resources[service].id);
    need(
        ids.every((value) => /^[a-f0-9]{64}$/u.test(value)),
        'LOAD_OBS_RESOURCE_CONTAINER'
    );
    const command = spawnSync(
        'docker',
        [
            'inspect',
            '--format',
            '{"id":{{json .Id}},"pid":{{.State.Pid}},"running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}},"restarts":{{.RestartCount}}}',
            ...ids,
        ],
        {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 8192,
            env: safeEnvironment(),
        }
    );
    need(command.status === 0 && !command.error, 'LOAD_OBS_RESOURCE_CONTAINER');
    let inspected;
    try {
        inspected = command.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
    } catch {
        throw new LoadObservationError('LOAD_OBS_RESOURCE_CONTAINER');
    }
    need(inspected.length === 5, 'LOAD_OBS_RESOURCE_CONTAINER');
    const containers = inspected.map((row, index) => {
        need(
            row.id === ids[index] &&
                row.running === true &&
                Number.isSafeInteger(row.pid) &&
                row.pid > 1,
            'LOAD_OBS_RESOURCE_CONTAINER'
        );
        const location = cgroup(row.pid, row.id);
        return {
            service: services[index],
            id: row.id,
            running: row.running,
            oomKilled: row.oomKilled,
            restarts: row.restarts,
            oomKillCount: keyed(
                boundedText(path.join(location, 'memory.events')),
                'oom_kill'
            ),
            cpuMicros: keyed(
                boundedText(path.join(location, 'cpu.stat')),
                'usage_usec'
            ),
            memoryBytes: integer(
                boundedText(path.join(location, 'memory.current')).trim()
            ),
        };
    });
    const space = fs.statfsSync(directory, { bigint: true }),
        free = space.bavail * space.bsize;
    need(
        free >= 0n && free <= BigInt(Number.MAX_SAFE_INTEGER),
        'LOAD_OBS_RESOURCE_DISK'
    );
    return {
        atMs: now(),
        freeBytes: Number(free),
        processes,
        containers,
        progress,
    };
}
/** Private append-only numeric log, exclusive per phase; a missing summary denotes an incomplete measurement. */
export function resourceFileWriter(directory) {
    privateDirectory(directory);
    let fd = null,
        count = 0,
        bytes = 0,
        phase = null;
    const close = () => {
        if (fd !== null) {
            try {
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
                fd = null;
            }
        }
    };
    return {
        async begin(input) {
            need(
                fd === null && ['pilot', 'full'].includes(input.phase),
                'LOAD_OBS_RESOURCE_FILE'
            );
            phase = input.phase;
            count = 0;
            bytes = 0;
            fd = fs.openSync(
                path.join(directory, 'resources-' + phase + '.ndjson'),
                fs.constants.O_WRONLY |
                    fs.constants.O_CREAT |
                    fs.constants.O_EXCL |
                    fs.constants.O_NOFOLLOW,
                0o600
            );
            const parent = fs.openSync(
                directory,
                fs.constants.O_RDONLY |
                    fs.constants.O_DIRECTORY |
                    fs.constants.O_NOFOLLOW
            );
            try {
                fs.fsyncSync(parent);
            } finally {
                fs.closeSync(parent);
            }
        },
        async append(sample) {
            const encoded = JSON.stringify(sample) + '\n';
            need(
                fd !== null &&
                    ++count <= RESOURCE_LIMITS.maximumSamples &&
                    Buffer.byteLength(encoded) <=
                        RESOURCE_LIMITS.maximumSampleBytes &&
                    bytes + Buffer.byteLength(encoded) <=
                        RESOURCE_LIMITS.maximumBytes,
                'LOAD_OBS_RESOURCE_BYTES'
            );
            fs.writeFileSync(fd, encoded);
            fs.fsyncSync(fd);
            bytes += Buffer.byteLength(encoded);
        },
        async finish(summary) {
            close();
            privateCheckpoint(
                path.join(directory, 'resources-' + phase + '-summary.json'),
                summary,
                true
            );
        },
        async abort() {
            close();
        },
    };
}
/** Root owns future invocation. Model warm state remains UNKNOWN: this sampler never calls a model endpoint. */
export async function createLoadResourceRuntime({
    state,
    fixture,
    statePath,
    directory,
    readProgress,
    onUnsafe,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    privateDirectory(directory);
    const admit = async () => loadObserverGuard({ state, statePath });
    await admit();
    need(
        typeof readProgress === 'function' && typeof onUnsafe === 'function',
        'LOAD_OBS_RESOURCE_ADAPTER'
    );
    const hz = getconf('CLK_TCK'),
        pageSize = getconf('PAGESIZE'),
        now = () => Math.floor(performance.now());
    return createResourceMeasurements({
        state,
        admit,
        readSample: async (input) =>
            readLinuxResources({
                state,
                directory,
                hz,
                pageSize,
                now,
                progress: await readProgress(input),
            }),
        writer: resourceFileWriter(directory),
        now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onUnsafe,
    });
}
