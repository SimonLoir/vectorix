/** Private browser-recipe I/O primitives; importing performs no I/O. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const PROTOCOL_VERSION = 2;
/** Exactly four closed scenarios; historical protocol-1 states cannot be adopted. */
export function scenarioSpec(scenario) {
    const specs = {
        INGESTION_V1: {
            namespace: 'vectorix-m7c-s3-outage',
            databaseStem: 'vectorix_m7c_s3_outage',
            objectPrefix: 'm7c-s3-outage',
        },
        VECTOR_PROVISION_V1: {
            namespace: 'vectorix-m7c-vector-provision',
            databaseStem: 'vectorix_m7c_vector_provision',
            objectPrefix: 'm7c-vector-provision',
        },
        CLEANUP_V1: {
            namespace: 'vectorix-m7c-s3-cleanup',
            databaseStem: 'vectorix_m7c_s3_cleanup',
            objectPrefix: 'm7c-s3-cleanup',
        },
        REDIS_V1: {
            namespace: 'vectorix-m7c-redis-outage',
            databaseStem: 'vectorix_m7c_redis_outage',
            objectPrefix: 'm7c-redis-outage',
        },
    };
    need(
        typeof scenario === 'string' && Object.hasOwn(specs, scenario),
        'M7C_S3_OUTAGE_SCENARIO_REQUIRED'
    );
    return specs[scenario];
}
export function receiptScope(state) {
    scenarioSpec(state.scenario);
    return {
        schemaVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        scenario: state.scenario,
        runId: state.runId,
    };
}
export function sameScope(state, receipt) {
    return (
        receipt &&
        Object.entries(receiptScope(state)).every(
            ([key, value]) => receipt[key] === value
        )
    );
}
export class RecipeError extends Error {}
export const need = (value, label) => {
    if (!value) throw new RecipeError(label);
};
export const cleanEnvironment = () =>
    Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]])
    );

export function privateBytes(filename, maximum = 128 * 1024) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const info = fs.fstatSync(descriptor);
        need(
            info.isFile() &&
                info.uid === process.getuid() &&
                (info.mode & 0o777) === 0o600 &&
                info.size <= maximum,
            'M7C_S3_OUTAGE_PRIVATE_FILE'
        );
        const bytes = fs.readFileSync(descriptor);
        need(bytes.length <= maximum, 'M7C_S3_OUTAGE_PRIVATE_BYTES');
        return bytes;
    } finally {
        fs.closeSync(descriptor);
    }
}

export function privateJson(filename, maximum = 128 * 1024) {
    return JSON.parse(privateBytes(filename, maximum).toString('utf8'));
}

export function writePrivate(filename, value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    need(bytes.length <= 16 * 1024, 'M7C_S3_OUTAGE_PRIVATE_OUTPUT_CAP');
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    const parent = fs.openSync(
        path.dirname(filename),
        fs.constants.O_RDONLY |
            fs.constants.O_DIRECTORY |
            fs.constants.O_NOFOLLOW
    );
    try {
        fs.fsyncSync(parent);
    } finally {
        fs.closeSync(parent);
    }
}

/** The primed vector poller may skip unobserved transition steps but can never move backwards. */
export function advanceVectorObserverTransition(previous, next) {
    const order = ['UP_PAUSED', 'DOWN_PAUSED', 'DOWN_RUNNING'];
    need(
        order.includes(next) &&
            (previous === null ||
                (order.includes(previous) &&
                    order.indexOf(next) >= order.indexOf(previous))),
        'S3_OUTAGE_VECTOR_OBSERVER_TRANSITION'
    );
    return next;
}

const GUARD_PURPOSES = [
    'seed',
    'bucket',
    'check',
    'smtp',
    'embedding',
    'observe',
    'staged-observe',
    'outage-observe',
    'vector-outage-watch',
];
const GUARD_STAGES = [
    'ADMISSION',
    'STATE',
    'SOURCE_PINS',
    'STORE_IDENTITY',
    'SCHEMA',
    'PROCESS_IDENTITY',
    'PROCESS_RUNSTATE',
    'SMTP',
    'CONTROL_PHASE',
];
const guardFailures = new WeakMap();
class IndependentGuardError extends RecipeError {
    constructor(descriptor) {
        super('M7C_S3_OUTAGE_INDEPENDENT_GUARD');
        guardFailures.set(this, Object.freeze(descriptor));
    }
}
/** Return only locally validated finite guard metadata, never properties of arbitrary errors. */
export function guardFailure(error) {
    return error !== null &&
        (typeof error === 'object' || typeof error === 'function')
        ? guardFailures.get(error)
        : undefined;
}
function ownData(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new Error();
    return descriptor?.value;
}
function guardResult(result, binding) {
    let status = null,
        outcome = 'INVALID_RESULT',
        stdout;
    const refuse = (stage = 'PROTOCOL', category = 'UNKNOWN') => {
        throw new IndependentGuardError({
            ...binding,
            stage,
            category,
            childOutcome: outcome,
            exitStatus: status,
        });
    };
    try {
        const code = ownData(result, 'status'),
            signal = ownData(result, 'signal'),
            error = ownData(result, 'error');
        if (
            code !== null &&
            (!Number.isSafeInteger(code) || code < 0 || code > 255)
        )
            return refuse();
        status = code;
        if (error !== undefined && error !== null) {
            outcome =
                ownData(error, 'code') === 'ETIMEDOUT'
                    ? 'TIMEOUT'
                    : 'SPAWN_ERROR';
            return refuse();
        }
        if (signal !== undefined && signal !== null) {
            if (typeof signal !== 'string') return refuse();
            outcome = 'SIGNAL';
            return refuse();
        }
        if (status === null) return refuse();
        outcome = status === 0 ? 'EXIT_ZERO' : 'NONZERO';
        stdout = ownData(result, 'stdout');
        if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16384)
            return refuse('PROTOCOL', 'INVALID_PROTOCOL');
    } catch (error) {
        if (guardFailure(error)) throw error;
        return refuse();
    }
    let proof;
    try {
        proof = JSON.parse(stdout);
    } catch {
        return refuse('PROTOCOL', 'INVALID_PROTOCOL');
    }
    if (!proof || typeof proof !== 'object' || Array.isArray(proof))
        return refuse('PROTOCOL', 'INVALID_PROTOCOL');
    if (status !== 0) {
        const keys = [
            ...Object.keys(binding),
            'completed',
            'stage',
            'category',
        ];
        if (
            JSON.stringify(Object.keys(proof).sort()) !==
                JSON.stringify(keys.sort()) ||
            proof.completed !== false ||
            !GUARD_STAGES.includes(proof.stage) ||
            !['REFUSED', 'ERROR', 'INTERRUPTED'].includes(proof.category)
        )
            return refuse('PROTOCOL', 'INVALID_PROTOCOL');
        if (
            !Object.entries(binding).every(
                ([key, value]) => proof[key] === value
            )
        )
            return refuse('PROTOCOL', 'CONTEXT_MISMATCH');
        return refuse(proof.stage, proof.category);
    }
    const keys = [
        'schemaVersion',
        'protocolVersion',
        'scenario',
        'namespace',
        'runId',
        'purpose',
        'resourceOwnership',
        'exactTestDatabases',
        'sourceBuildPins',
        ...(binding.purpose === 'vector-outage-watch'
            ? ['vectorTransition']
            : []),
    ];
    if (
        JSON.stringify(Object.keys(proof).sort()) !==
            JSON.stringify(keys.sort()) ||
        ![
            'schemaVersion',
            'protocolVersion',
            'scenario',
            'namespace',
            'runId',
            'purpose',
        ].every((key) => proof[key] === binding[key]) ||
        proof.resourceOwnership !== true ||
        proof.exactTestDatabases !== true ||
        proof.sourceBuildPins !== true
    )
        return refuse('PROTOCOL', 'INVALID_PROTOCOL');
    return proof;
}
/** The real independent child boundary; injection is confined to offline child-outcome tests. */
export function createGuardRecheck(state, purpose, execute = spawnSync) {
    const spec = scenarioSpec(state.scenario),
        run = state.runId,
        sourceSha256 = state.inputs?.helpers?.['lifecycle.py'];
    need(
        /^[a-f0-9]{12}$/u.test(run) &&
            state.namespace === spec.namespace &&
            GUARD_PURPOSES.includes(purpose) &&
            typeof sourceSha256 === 'string' &&
            /^[a-f0-9]{64}$/u.test(sourceSha256),
        'M7C_S3_OUTAGE_GUARD_BINDING'
    );
    const binding = Object.freeze({
        schemaVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        guardProtocol: 1,
        scenario: state.scenario,
        namespace: spec.namespace,
        runId: run,
        purpose,
        sourceSha256,
    });
    let vectorTransition = null;
    return (maximumMilliseconds = 120000) => {
        need(
            Number.isSafeInteger(maximumMilliseconds) &&
                maximumMilliseconds >= 1 &&
                maximumMilliseconds <= 120000,
            'M7C_S3_OUTAGE_GUARD_TIMEOUT'
        );
        let result;
        try {
            result = execute(
                'python3',
                [
                    path.join(HERE, 'lifecycle.py'),
                    '--run',
                    run,
                    '--scenario',
                    state.scenario,
                    '--mode',
                    'guard',
                    '--purpose',
                    purpose,
                ],
                {
                    cwd: ROOT,
                    env: cleanEnvironment(),
                    timeout:
                        purpose === 'vector-outage-watch'
                            ? Math.min(15000, maximumMilliseconds)
                            : maximumMilliseconds,
                    maxBuffer: 16384,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                }
            );
        } catch {
            throw new IndependentGuardError({
                ...binding,
                stage: 'PROTOCOL',
                category: 'UNKNOWN',
                childOutcome: 'SPAWN_ERROR',
                exitStatus: null,
            });
        }
        const proof = guardResult(result, binding);
        if (purpose === 'vector-outage-watch') {
            need(
                state.scenario === 'VECTOR_PROVISION_V1',
                'S3_OUTAGE_VECTOR_OBSERVER_SCENARIO'
            );
            vectorTransition = advanceVectorObserverTransition(
                vectorTransition,
                proof.vectorTransition
            );
        }
        return proof;
    };
}

export function context(args, purpose) {
    need(
        args.length === 4 &&
            args[0] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[1]) &&
            args[2] === '--scenario',
        'M7C_S3_OUTAGE_ARGUMENTS'
    );
    need(
        [
            'seed',
            'bucket',
            'check',
            'smtp',
            'embedding',
            'observe',
            'staged-observe',
            'outage-observe',
            'vector-outage-watch',
        ].includes(purpose),
        'M7C_S3_OUTAGE_PURPOSE'
    );
    const run = args[1],
        scenario = args[3],
        spec = scenarioSpec(scenario),
        directory = path.join(
            ROOT,
            'node_modules/.cache/vectorix/' + spec.namespace + '-' + run
        );
    for (const candidate of [HERE, directory]) {
        const info = fs.lstatSync(candidate);
        need(
            info.isDirectory() &&
                info.uid === process.getuid() &&
                (candidate === HERE
                    ? [0o700, 0o755].includes(info.mode & 0o777)
                    : (info.mode & 0o777) === 0o700) &&
                fs.realpathSync(candidate) === candidate,
            'M7C_S3_OUTAGE_PRIVATE_DIRECTORY'
        );
    }
    const state = privateJson(path.join(directory, 'state.json'));
    need(
        state.schemaVersion === 1 &&
            state.protocolVersion === PROTOCOL_VERSION &&
            state.scenario === scenario &&
            state.namespace === spec.namespace &&
            state.runId === run &&
            state.applicationDatabase ===
                `${spec.databaseStem}_app_${run}_test` &&
            state.vectorDatabase === `${spec.databaseStem}_vectors_${run}_test`,
        'M7C_S3_OUTAGE_STATE'
    );
    const recheck = createGuardRecheck(state, purpose);
    recheck();
    // Prevent SDK/profile/dotenv/credential resolution from inheriting the operator shell.
    const safe = cleanEnvironment();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, safe, {
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        DOTENV_CONFIG_PATH: '/dev/null',
    });
    return { state, run, directory, recheck };
}

/** Call only after context() has checked pins/ownership and removed ambient environment. */
export async function openFixturePrisma(state, readOnly) {
    need(readOnly === true, 'M7C_S3_OUTAGE_PRISMA_READ_ONLY_REQUIRED');
    const url = new URL(state.environment.DATABASE_URL);
    need(
        url.protocol === 'postgresql:' &&
            url.hostname === '127.0.0.1' &&
            Number(url.port) === state.ports.postgres &&
            url.username === 'postgres' &&
            url.pathname === '/' + state.applicationDatabase &&
            url.search === '' &&
            url.hash === '' &&
            state.applicationDatabase ===
                `${scenarioSpec(state.scenario).databaseStem}_app_${state.runId}_test`,
        'M7C_S3_OUTAGE_PRISMA_EXACT_DATABASE'
    );
    const fromApi = createRequire(path.join(ROOT, 'apps/api/package.json'));
    const fromDb = createRequire(path.join(ROOT, 'packages/db/package.json'));
    const tsxEntry = fromApi.resolve('tsx/esm/api'),
        adapterEntry = fromDb.resolve('@prisma/adapter-pg');
    for (const [name, filename] of [
        ['tsx', tsxEntry],
        ['@prisma/adapter-pg', adapterEntry],
    ]) {
        const actual = fs.realpathSync(filename);
        need(
            Object.values(state.inputs.runtime).some(
                (row) =>
                    row.name === name && actual.startsWith(row.root + path.sep)
            ),
            'M7C_S3_OUTAGE_PRISMA_PINNED_RUNTIME'
        );
    }
    const entry = path.join(ROOT, 'packages/db/src/generated/client/client.ts');
    need(
        fs.realpathSync(entry) ===
            path.join(
                state.inputs.runtime['generated-client'].root,
                'client.ts'
            ),
        'M7C_S3_OUTAGE_PRISMA_PINNED_GENERATED_CLIENT'
    );
    const { tsImport } = await import(pathToFileURL(tsxEntry).href);
    const { PrismaClient } = await tsImport(pathToFileURL(entry).href, {
        parentURL: import.meta.url,
        tsconfig: false,
    });
    const { PrismaPg } = fromDb('@prisma/adapter-pg');
    return new PrismaClient({
        adapter: new PrismaPg({
            connectionString: url.href,
            connectionTimeoutMillis: 5000,
            query_timeout: 10000,
            options:
                '-c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000' +
                (readOnly ? ' -c default_transaction_read_only=on' : ''),
        }),
        log: [],
    });
}

export function entryError(error) {
    // Only our fixed vocabulary crosses the process boundary; no raw SDK/HTTP/SQL diagnostics.
    const diagnostic =
        error instanceof RecipeError &&
        /^(?:M7C_S3_OUTAGE_|S3_OUTAGE_)[A-Z0-9_]{1,70}$/u.test(error.message)
            ? error.message
            : 'M7C_S3_OUTAGE_SANITIZED_FAILURE';
    console.log(
        JSON.stringify({
            completed: false,
            diagnostic,
            guardFailure: guardFailure(error),
        })
    );
    process.exitCode = 1;
}
