/** Traffic-only asynchronous ownership admission; import starts no child, socket, timer or SDK. */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { need, same, LoadObservationError } from './load-observer-core.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url)),
    ROOT = path.resolve(HERE, '../../..');
const now = () => Math.round(performance.now() * 1000);
/** Exact finite guard output only. Raw child stdout/stderr never enters diagnostics or durable evidence. */
export function checkedTrafficGuard(value, state) {
    need(
        value &&
            same(Object.keys(value).sort(), [
                'bootstrapFreshness',
                'databaseReadOnly',
                'namespace',
                'purpose',
                'resourceOwnership',
                'runId',
                'schemaVersion',
            ]) &&
            value.schemaVersion === 1 &&
            value.namespace === state.namespace &&
            value.runId === state.runId &&
            value.purpose === 'import' &&
            value.resourceOwnership === true &&
            value.databaseReadOnly === true &&
            value.bootstrapFreshness === false,
        'LOAD_OBS_GUARD'
    );
}
/** Pure injected wrapper proves timing and fail-closed decoding without invoking a real process in tests. */
export function trafficGuardCore({ state, statePath, execute, clock = now }) {
    need(
        statePath ===
            path.join(
                ROOT,
                'node_modules/.cache/vectorix',
                state.prefix,
                'state.json'
            ) &&
            state.prefix === 'vectorix-m7c-load-' + state.runId &&
            typeof execute === 'function',
        'LOAD_OBS_GUARD'
    );
    let count = 0,
        totalMicros = 0,
        maximumMicros = 0;
    return {
        async admit() {
            const started = clock();
            let value;
            try {
                value = await execute();
                checkedTrafficGuard(value, state);
            } catch {
                throw new LoadObservationError('LOAD_OBS_GUARD');
            }
            const elapsed = clock() - started;
            need(
                Number.isSafeInteger(elapsed) &&
                    elapsed >= 0 &&
                    ++count <= 50000,
                'LOAD_OBS_GUARD'
            );
            totalMicros += elapsed;
            maximumMicros = Math.max(maximumMicros, elapsed);
            need(Number.isSafeInteger(totalMicros), 'LOAD_OBS_GUARD');
        },
        summary: () => ({
            count,
            totalMicros,
            maximumMicros,
            definition:
                'ASYNC_OWNERSHIP_CHILD_WALL_TIME_INCLUDES_OPERATOR_GUARDS',
        }),
    };
}
/** Same command/parent-PID/pins as the reviewed synchronous observer guard, with no shell and finite output/deadline. */
export function createTrafficGuard({ state, statePath }) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    return trafficGuardCore({
        state,
        statePath,
        execute: () =>
            new Promise((resolve, reject) => {
                execFile(
                    'python3',
                    [
                        '-B',
                        path.join(HERE, 'load-topology.py'),
                        '--run',
                        state.runId,
                        '--mode',
                        'guard',
                        '--purpose',
                        'import',
                    ],
                    {
                        cwd: ROOT,
                        env: Object.fromEntries(
                            ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
                                .filter((key) => process.env[key] !== undefined)
                                .map((key) => [key, process.env[key]])
                        ),
                        timeout: 30000,
                        maxBuffer: 16384,
                        encoding: 'utf8',
                    },
                    (error, stdout) => {
                        if (error) {
                            reject(new LoadObservationError('LOAD_OBS_GUARD'));
                            return;
                        }
                        try {
                            resolve(JSON.parse(stdout));
                        } catch {
                            reject(new LoadObservationError('LOAD_OBS_GUARD'));
                        }
                    }
                );
            }),
    });
}
