/** Guarded fixture adapters. Importing this module opens no files, clients, sockets or subprocesses. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
    DRAFT_ONLY,
    BOOTSTRAP_LIMITS,
    LoadBootstrapError,
    bootstrapNeed,
    safeBootstrapError,
    validateBootstrapConfig,
    bootstrapLoadFixture,
} from './load-bootstrap.mjs';

export const RUNTIME_DRAFT_ONLY = false;
const ROLES = ['owner', 'reader', 'foreign'];
const OPERATIONS = new Set([
    'sign-up/email',
    'organization/create',
    'organization/set-active',
    'organization/create-role',
    'sign-out',
]);
const SAFE_ENV_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'];

/** Actual decoded bytes are counted even when the Content-Length header is absent or false. */
export async function readBootstrapResponse(response) {
    let reader;
    try {
        bootstrapNeed(
            response &&
                Number.isInteger(response.status) &&
                !(response.status >= 300 && response.status < 400),
            'LOAD_BOOTSTRAP_HTTP_RESPONSE'
        );
        const advertised = response.headers.get('content-length');
        bootstrapNeed(
            advertised === null ||
                (/^\d+$/u.test(advertised) &&
                    Number(advertised) <= BOOTSTRAP_LIMITS.responseBytes),
            'LOAD_BOOTSTRAP_HTTP_CAP'
        );
        reader = response.body?.getReader();
        let used = 0;
        const bytes = Buffer.alloc(BOOTSTRAP_LIMITS.responseBytes);
        if (reader)
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                bootstrapNeed(
                    part.value instanceof Uint8Array &&
                        part.value.length <=
                            BOOTSTRAP_LIMITS.responseBytes - used,
                    'LOAD_BOOTSTRAP_HTTP_CAP'
                );
                // Copy a small view so a hostile stream cannot retain an unbounded backing buffer.
                bytes.set(part.value, used);
                used += part.value.length;
            }
        bootstrapNeed(
            response.ok,
            response.status === 429
                ? 'LOAD_BOOTSTRAP_RATE_LIMITED'
                : 'LOAD_BOOTSTRAP_HTTP_RESPONSE'
        );
        let value;
        try {
            value = JSON.parse(bytes.subarray(0, used).toString('utf8'));
        } catch {
            throw new LoadBootstrapError('LOAD_BOOTSTRAP_HTTP_RESPONSE');
        }
        bootstrapNeed(
            value && typeof value === 'object' && !Array.isArray(value),
            'LOAD_BOOTSTRAP_HTTP_RESPONSE'
        );
        return value;
    } catch (error) {
        throw new LoadBootstrapError(
            safeBootstrapError(error, 'LOAD_BOOTSTRAP_HTTP_RESPONSE')
        );
    } finally {
        if (reader) {
            try {
                Promise.resolve(reader.cancel()).catch(() => {});
            } catch {
                /* Preserve the finite original refusal. */
            }
            try {
                reader.releaseLock();
            } catch {
                /* Do not expose adapter diagnostics. */
            }
        } else {
            try {
                Promise.resolve(response?.body?.cancel()).catch(() => {});
            } catch {
                /* Never await hostile cancellation. */
            }
        }
    }
}

/** Exact auth-only transport: no arbitrary URL, RPC, invite, admin, key, content or grant operation. */
export function createBootstrapTransport(
    state,
    { fetchImpl, now = Date.now } = {}
) {
    validateBootstrapConfig(state);
    bootstrapNeed(
        typeof fetchImpl === 'function' && typeof now === 'function',
        'LOAD_BOOTSTRAP_DEPENDENCIES'
    );
    const jars = new Map(ROLES.map((role) => [role, new Map()])),
        started = now();
    let calls = 0,
        closed = false;
    async function authChecked(role, operation, body, method) {
        bootstrapNeed(
            !closed &&
                jars.has(role) &&
                ((method === 'POST' && OPERATIONS.has(operation)) ||
                    (method === 'GET' && operation === 'get-session')),
            'LOAD_BOOTSTRAP_HTTP_OPERATION'
        );
        bootstrapNeed(
            ++calls <= BOOTSTRAP_LIMITS.authCalls &&
                Number.isSafeInteger(now()) &&
                now() >= started &&
                now() - started <= BOOTSTRAP_LIMITS.durationMs,
            'LOAD_BOOTSTRAP_TIME_BUDGET'
        );
        const bytes = method === 'GET' ? undefined : JSON.stringify(body);
        bootstrapNeed(
            bytes === undefined ||
                (typeof bytes === 'string' &&
                    Buffer.byteLength(bytes) <= BOOTSTRAP_LIMITS.requestBytes),
            'LOAD_BOOTSTRAP_HTTP_CAP'
        );
        const cookies = jars.get(role);
        const url = state.apiOrigin + '/api/auth/' + operation;
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                headers: {
                    origin: state.webOrigin,
                    cookie: [...cookies]
                        .map(([key, value]) => key + '=' + value)
                        .join('; '),
                    ...(method === 'POST'
                        ? { 'content-type': 'application/json' }
                        : {}),
                },
                ...(bytes === undefined ? {} : { body: bytes }),
                redirect: 'manual',
                signal: AbortSignal.timeout(BOOTSTRAP_LIMITS.requestMs),
            });
        } catch {
            throw new LoadBootstrapError('LOAD_BOOTSTRAP_TRANSPORT_FAILED');
        }
        const value = await readBootstrapResponse(response);
        const setCookies = response.headers.getSetCookie();
        bootstrapNeed(
            setCookies.length <= 16 &&
                setCookies.reduce((sum, item) => sum + item.length, 0) <= 32768,
            'LOAD_BOOTSTRAP_HTTP_COOKIE'
        );
        for (const cookie of setCookies) {
            const pair = cookie.split(';', 1)[0],
                separator = pair.indexOf('=');
            bootstrapNeed(
                separator > 0 &&
                    separator < 128 &&
                    pair.length <= 8192 &&
                    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(
                        pair.slice(0, separator)
                    ) &&
                    !/[\r\n\x00-\x20\x7f]/u.test(pair),
                'LOAD_BOOTSTRAP_HTTP_COOKIE'
            );
            const name = pair.slice(0, separator),
                token = pair.slice(separator + 1);
            bootstrapNeed(
                cookies.has(name) || cookies.size < 16,
                'LOAD_BOOTSTRAP_HTTP_COOKIE'
            );
            if (token) cookies.set(name, token);
            else cookies.delete(name);
        }
        return value;
    }
    async function auth(...args) {
        try {
            return await authChecked(...args);
        } catch (error) {
            throw new LoadBootstrapError(
                safeBootstrapError(error, 'LOAD_BOOTSTRAP_TRANSPORT_FAILED')
            );
        }
    }
    return {
        post: (role, operation, body) => auth(role, operation, body, 'POST'),
        getSession: (role) => auth(role, 'get-session', undefined, 'GET'),
        discardSessions() {
            closed = true;
            for (const cookies of jars.values()) cookies.clear();
        },
    };
}

/** Strict proof from the fixed sibling read-only guard; diagnostics never include its raw output. */
export function validateBootstrapGuardProof(value, run) {
    bootstrapNeed(
        value &&
            Object.keys(value).sort().join(',') ===
                [
                    'schemaVersion',
                    'namespace',
                    'runId',
                    'purpose',
                    'resourceOwnership',
                    'databaseReadOnly',
                    'bootstrapFreshness',
                ]
                    .sort()
                    .join(',') &&
            value.schemaVersion === 1 &&
            value.namespace === 'vectorix-m7c-load' &&
            value.runId === run &&
            value.purpose === 'bootstrap' &&
            value.resourceOwnership === true &&
            value.databaseReadOnly === true &&
            value.bootstrapFreshness === true,
        'LOAD_BOOTSTRAP_GUARD_REFUSED'
    );
    return value;
}

/** This guard does not acquire the lifecycle lock already held by the parent seed command. */
function guardBootstrap(root, directory, run) {
    const env = Object.fromEntries(
        SAFE_ENV_KEYS.filter((key) => process.env[key] !== undefined).map(
            (key) => [key, process.env[key]]
        )
    );
    const result = spawnSync(
        'python3',
        [
            path.join(directory, 'load-topology.py'),
            '--run',
            run,
            '--mode',
            'guard',
            '--purpose',
            'bootstrap',
        ],
        {
            cwd: root,
            env,
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 16384,
        }
    );
    bootstrapNeed(
        result.status === 0 &&
            !result.error &&
            Buffer.byteLength(result.stdout ?? '') <= 16384 &&
            Buffer.byteLength(result.stderr ?? '') <= 16384,
        'LOAD_BOOTSTRAP_GUARD_REFUSED'
    );
    let proof;
    try {
        proof = JSON.parse(result.stdout);
    } catch {
        throw new LoadBootstrapError('LOAD_BOOTSTRAP_GUARD_REFUSED');
    }
    validateBootstrapGuardProof(proof, run);
}

function existsNoFollow(filename) {
    try {
        fs.lstatSync(filename);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw new LoadBootstrapError('LOAD_BOOTSTRAP_PRIVATE_FILE');
    }
}

/** Persist the directory entry after exclusive create or atomic checkpoint replacement. */
function syncPrivateDirectory(directory) {
    const descriptor = fs.openSync(
        directory,
        fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW
    );
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

/** Reviewed-only CLI adapter; no provisioning, migrations, providers or resource writes are included. */
export async function runBootstrapRuntime(args) {
    if (DRAFT_ONLY || RUNTIME_DRAFT_ONLY)
        throw new LoadBootstrapError('LOAD_BOOTSTRAP_DRAFT_ONLY');
    bootstrapNeed(
        Array.isArray(args) &&
            args.length === 2 &&
            args[0] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[1]),
        'LOAD_BOOTSTRAP_ARGUMENTS'
    );
    const {
        discoverWorkspace,
        privateDirectory,
        readPrivate,
        privateCheckpoint,
    } = await import('./load-private.mjs');
    const directory = path.dirname(fileURLToPath(import.meta.url)),
        root = discoverWorkspace(directory),
        run = args[1];
    const runDirectory = path.join(
        root,
        'node_modules/.cache/vectorix',
        'vectorix-m7c-load-' + run
    );
    const statePath = path.join(runDirectory, 'state.json'),
        progressPath = path.join(runDirectory, 'bootstrap-progress.json'),
        fixturePath = path.join(runDirectory, 'fixture.json');
    privateDirectory(runDirectory);
    bootstrapNeed(
        ![
            progressPath,
            progressPath + '.next',
            fixturePath,
            fixturePath + '.next',
        ].some(existsNoFollow),
        'LOAD_BOOTSTRAP_PRIOR_PROGRESS'
    );
    let state;
    try {
        state = JSON.parse(readPrivate(statePath, BOOTSTRAP_LIMITS.stateBytes));
    } catch {
        throw new LoadBootstrapError('LOAD_BOOTSTRAP_PRIVATE_FILE');
    }
    validateBootstrapConfig(state);
    bootstrapNeed(state.runId === run, 'LOAD_BOOTSTRAP_CONFIG');
    guardBootstrap(root, directory, run); // Before tsx, generated Prisma imports, clients or authentication.
    for (const key of Object.keys(process.env))
        if (!SAFE_ENV_KEYS.includes(key)) delete process.env[key];
    process.env.DATABASE_URL = state.environment.DATABASE_URL;
    let database,
        transport,
        journal,
        first = true;
    const checkpoint = async (value) => {
        bootstrapNeed(
            Buffer.byteLength(JSON.stringify(value)) <=
                BOOTSTRAP_LIMITS.journalBytes,
            'LOAD_BOOTSTRAP_CHECKPOINT_FAILED'
        );
        privateCheckpoint(progressPath, value, first);
        syncPrivateDirectory(runDirectory);
        first = false;
        journal = structuredClone(value);
    };
    try {
        const require = createRequire(path.join(root, 'apps/api/package.json'));
        const { tsImport } = await import(require.resolve('tsx/esm/api'));
        const { PrismaClient } = await tsImport(
            pathToFileURL(path.join(root, 'packages/db/src/index.ts')).href,
            import.meta.url
        );
        const { PrismaPg } = createRequire(
            path.join(root, 'packages/db/package.json')
        )('@prisma/adapter-pg');
        database = new PrismaClient({
            adapter: new PrismaPg({
                connectionString: state.environment.DATABASE_URL,
                connectionTimeoutMillis: 5000,
            }),
        });
        transport = createBootstrapTransport(state, {
            fetchImpl: globalThis.fetch,
        });
        const fixture = await bootstrapLoadFixture({
            state,
            transport,
            database,
            checkpoint,
        });
        bootstrapNeed(
            Buffer.byteLength(JSON.stringify(fixture)) <=
                BOOTSTRAP_LIMITS.fixtureBytes,
            'LOAD_BOOTSTRAP_FIXTURE'
        );
        privateCheckpoint(fixturePath, fixture, true);
        syncPrivateDirectory(runDirectory);
        await checkpoint({ ...journal, status: 'FIXTURE_WRITTEN' });
        await database.$disconnect();
        database = undefined;
        console.log(
            JSON.stringify({
                completed: true,
                status: 'FIXTURE_BOOTSTRAPPED',
                runId: run,
                users: 3,
                organizations: 2,
                memberships: 3,
                superadmins: 0,
                apiKeys: 0,
                documents: 0,
                collections: 0,
                loadAcceptance: 'NOT_RUN',
            })
        );
        return { completed: true };
    } catch (error) {
        throw new LoadBootstrapError(safeBootstrapError(error));
    } finally {
        try {
            transport?.discardSessions();
            try {
                await database?.$disconnect();
            } catch {
                throw new LoadBootstrapError('LOAD_BOOTSTRAP_DATABASE_FAILED');
            }
        } finally {
            delete process.env.DATABASE_URL;
        }
    }
}
