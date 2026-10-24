/** Private browser-recipe I/O primitives; importing performs no I/O. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
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

export function context(args, purpose) {
    need(
        args.length === 2 &&
            args[0] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[1]),
        'M7C_S3_OUTAGE_ARGUMENTS'
    );
    need(
        [
            'seed',
            'bucket',
            'check',
            'smtp',
            'observe',
            'staged-observe',
            'outage-observe',
        ].includes(purpose),
        'M7C_S3_OUTAGE_PURPOSE'
    );
    const run = args[1],
        directory = path.join(
            ROOT,
            'node_modules/.cache/vectorix/vectorix-m7c-s3-outage-' + run
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
        state.namespace === 'vectorix-m7c-s3-outage' &&
            state.runId === run &&
            state.applicationDatabase ===
                `vectorix_m7c_s3_outage_app_${run}_test` &&
            state.vectorDatabase ===
                `vectorix_m7c_s3_outage_vectors_${run}_test`,
        'M7C_S3_OUTAGE_STATE'
    );
    const recheck = () => {
        const result = spawnSync(
            'python3',
            [
                path.join(HERE, 'lifecycle.py'),
                '--run',
                run,
                '--mode',
                'guard',
                '--purpose',
                purpose,
            ],
            {
                cwd: ROOT,
                env: cleanEnvironment(),
                timeout: 120000,
                maxBuffer: 16384,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
            }
        );
        need(
            !result.error &&
                result.status === 0 &&
                Buffer.byteLength(result.stdout ?? '') <= 16384,
            'M7C_S3_OUTAGE_INDEPENDENT_GUARD'
        );
        let proof;
        try {
            proof = JSON.parse(result.stdout);
        } catch {
            throw new RecipeError('M7C_S3_OUTAGE_INDEPENDENT_GUARD');
        }
        need(
            JSON.stringify(Object.keys(proof).sort()) ===
                JSON.stringify(
                    [
                        'schemaVersion',
                        'namespace',
                        'runId',
                        'purpose',
                        'resourceOwnership',
                        'exactTestDatabases',
                        'sourceBuildPins',
                    ].sort()
                ) &&
                proof.schemaVersion === 1 &&
                proof.namespace === state.namespace &&
                proof.runId === run &&
                proof.purpose === purpose &&
                proof.resourceOwnership === true &&
                proof.exactTestDatabases === true &&
                proof.sourceBuildPins === true,
            'M7C_S3_OUTAGE_INDEPENDENT_GUARD'
        );
    };
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
                `vectorix_m7c_s3_outage_app_${state.runId}_test`,
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
    console.log(JSON.stringify({ completed: false, diagnostic }));
    process.exitCode = 1;
}
