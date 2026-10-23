/** Guarded local quality-bucket setup. Imports do not construct clients or inspect resources. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from './workspace-root.mjs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';

export const DRAFT_ONLY = false;
export class QualityBucketError extends Error {}
const check = (value, label) => {
    if (!value) throw new QualityBucketError(label);
};

export function validateBucketState(state, run) {
    check(
        /^[a-f0-9]{12}$/u.test(run) &&
            state.schemaVersion === 1 &&
            state.namespace === 'vectorix-m7c-quality' &&
            state.runId === run &&
            state.prefix === 'vectorix-m7c-quality-' + run &&
            state.phase === 'APP_DB_EMPTY_SCHEMA_REQUIRED',
        'QUALITY_BUCKET_STATE'
    );
    const env = state.environment;
    check(
        Number.isInteger(state.ports.rustfs) &&
            state.ports.rustfs > 1024 &&
            state.ports.rustfs < 65536 &&
            env.VECTORIX_DEFAULT_S3_ENDPOINT ===
                `http://127.0.0.1:${state.ports.rustfs}` &&
            env.VECTORIX_S3_ALLOWED_ENDPOINTS ===
                env.VECTORIX_DEFAULT_S3_ENDPOINT &&
            env.VECTORIX_DEFAULT_S3_BUCKET === 'm7c-quality-' + run &&
            env.VECTORIX_DEFAULT_S3_REGION === 'us-east-1' &&
            env.VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE === 'true' &&
            env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID === 'm7c-quality-' + run &&
            /^[A-Za-z0-9_-]{32,128}$/u.test(
                env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY
            ),
        'QUALITY_BUCKET_BINDING'
    );
    return state;
}

export function validateBucketGuard(value, run) {
    check(
        value?.schemaVersion === 1 &&
            value.namespace === 'vectorix-m7c-quality' &&
            value.runId === run &&
            value.purpose === 'bucket' &&
            value.resourceOwnership === true &&
            value.databaseReadOnly === true &&
            value.bootstrapFreshness === true,
        'QUALITY_BUCKET_RESOURCE_GUARD'
    );
}

/** Injected finite setup sequence. A pre-existing bucket is refused, never adopted or made public. */
export async function initializeQualityBucket({
    state,
    api,
    anonymousList,
    checkpoint,
}) {
    validateBucketState(state, state.runId);
    const bucket = state.environment.VECTORIX_DEFAULT_S3_BUCKET;
    const before = await api.listBuckets();
    check(
        Array.isArray(before) && before.length === 0,
        'QUALITY_BUCKET_REQUIRES_EMPTY_STORE'
    );
    await api.createBucket(bucket);
    await api.headBucket(bucket);
    const after = await api.listBuckets();
    check(
        Array.isArray(after) && after.length === 1 && after[0] === bucket,
        'QUALITY_BUCKET_EXACT_INVENTORY'
    );
    const versioning = await api.getBucketVersioning(bucket);
    check(
        versioning &&
            versioning.Status === undefined &&
            versioning.MFADelete === undefined,
        'QUALITY_BUCKET_UNVERSIONED_REQUIRED'
    );
    const objects = await api.listObjects(bucket);
    check(
        objects &&
            (objects.Contents ?? []).length === 0 &&
            objects.IsTruncated !== true,
        'QUALITY_BUCKET_EMPTY_REQUIRED'
    );
    const status = await anonymousList(bucket);
    check(
        status === 401 || status === 403,
        'QUALITY_BUCKET_ANONYMOUS_LIST_MUST_BE_DENIED'
    );
    const proof = {
        completed: true,
        runId: state.runId,
        initializedBuckets: 1,
        emptyInventoryObserved: true,
        anonymousListDenied: true,
        unversioned: true,
        coverage: 'OWNED_BUCKET_SETUP_ONLY_NOT_ALL_OBJECT_PRIVACY_OR_BACKUP',
    };
    await checkpoint(proof);
    return proof;
}

function privateJson(file, maximum) {
    const handle = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const stat = fs.fstatSync(handle);
        check(
            stat.isFile() &&
                stat.uid === process.getuid() &&
                (stat.mode & 0o777) === 0o600 &&
                stat.size <= maximum,
            'QUALITY_BUCKET_PRIVATE_FILE'
        );
        const bytes = fs.readFileSync(handle);
        check(bytes.length <= maximum, 'QUALITY_BUCKET_PRIVATE_BYTES');
        return JSON.parse(bytes.toString());
    } finally {
        fs.closeSync(handle);
    }
}

function guard(root, run) {
    const result = spawnSync(
        'python3',
        [
            fileURLToPath(new URL('./quality-topology.py', import.meta.url)),
            '--run',
            run,
            '--mode',
            'guard',
            '--purpose',
            'bucket',
        ],
        {
            cwd: root,
            env: Object.fromEntries(
                ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
                    .filter((key) => process.env[key] !== undefined)
                    .map((key) => [key, process.env[key]])
            ),
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 16384,
        }
    );
    check(
        result.status === 0 && !result.error,
        'QUALITY_BUCKET_INDEPENDENT_GUARD'
    );
    validateBucketGuard(JSON.parse(result.stdout), run);
}

async function nativeApi(root, state) {
    const require = createRequire(path.join(root, 'apps/api/package.json'));
    const sdk = require('@aws-sdk/client-s3');
    const { NodeHttpHandler } = createRequire(
        require.resolve('@aws-sdk/client-s3')
    )('@smithy/node-http-handler');
    const endpoint = state.environment.VECTORIX_DEFAULT_S3_ENDPOINT;
    const transport = new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true,
    });
    const allowed = new Set([
        sdk.ListBucketsCommand,
        sdk.CreateBucketCommand,
        sdk.HeadBucketCommand,
        sdk.GetBucketVersioningCommand,
        sdk.ListObjectsV2Command,
    ]);
    const handler = {
        async handle(request, options) {
            check(
                request.protocol === 'http:' &&
                    request.hostname === '127.0.0.1' &&
                    Number(request.port) === state.ports.rustfs,
                'QUALITY_BUCKET_EXACT_LOOPBACK'
            );
            const result = await transport.handle(request, options);
            if (
                result.response.statusCode >= 300 &&
                result.response.statusCode < 400
            ) {
                result.response.body?.destroy();
                throw new QualityBucketError('QUALITY_BUCKET_REDIRECT_REFUSED');
            }
            if (result.response.body) {
                const original = result.response.body;
                let bytes = 0;
                const bounded = new Transform({
                    transform(part, _encoding, callback) {
                        bytes += part.byteLength;
                        callback(
                            part instanceof Uint8Array && bytes <= 65536
                                ? null
                                : new QualityBucketError(
                                      'QUALITY_BUCKET_RESPONSE_CAP'
                                  ),
                            part
                        );
                    },
                });
                original.on('error', (error) => bounded.destroy(error));
                bounded.on('error', () => {});
                bounded.on('close', () => {
                    if (!original.destroyed) original.destroy();
                });
                result.response.body = original.pipe(bounded);
            }
            return result;
        },
        destroy: () => transport.destroy(),
        updateHttpClientConfig: (key, value) =>
            transport.updateHttpClientConfig(key, value),
        httpHandlerConfigs: () => transport.httpHandlerConfigs(),
    };
    const client = new sdk.S3Client({
        endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: state.environment.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID,
            secretAccessKey:
                state.environment.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY,
        },
        maxAttempts: 1,
        followRegionRedirects: false,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: handler,
    });
    const deadline = performance.now() + 30000;
    async function send(Command, input) {
        check(
            allowed.has(Command) && performance.now() < deadline,
            'QUALITY_BUCKET_COMMAND_OR_DEADLINE'
        );
        const response = await client.send(new Command(input), {
            abortSignal: AbortSignal.timeout(
                Math.max(
                    1,
                    Math.min(5000, Math.floor(deadline - performance.now()))
                )
            ),
        });
        check(
            response.$metadata?.httpStatusCode === 200,
            'QUALITY_BUCKET_NATIVE_STATUS'
        );
        return response;
    }
    return {
        api: {
            listBuckets: async () =>
                (await send(sdk.ListBucketsCommand, {})).Buckets?.map(
                    (row) => row.Name
                ) ?? [],
            createBucket: (bucket) =>
                send(sdk.CreateBucketCommand, { Bucket: bucket }),
            headBucket: (bucket) =>
                send(sdk.HeadBucketCommand, { Bucket: bucket }),
            getBucketVersioning: (bucket) =>
                send(sdk.GetBucketVersioningCommand, { Bucket: bucket }),
            listObjects: (bucket) =>
                send(sdk.ListObjectsV2Command, { Bucket: bucket, MaxKeys: 1 }),
        },
        async anonymousList(bucket) {
            check(
                bucket === state.environment.VECTORIX_DEFAULT_S3_BUCKET &&
                    performance.now() < deadline,
                'QUALITY_BUCKET_ANONYMOUS_SCOPE'
            );
            const response = await fetch(
                endpoint +
                    '/' +
                    encodeURIComponent(bucket) +
                    '?list-type=2&max-keys=1',
                { redirect: 'manual', signal: AbortSignal.timeout(5000) }
            );
            void response.body?.cancel().catch(() => {});
            return response.status;
        },
        close: () => client.destroy(),
    };
}

async function main() {
    check(!DRAFT_ONLY, 'QUALITY_BUCKET_DRAFT_AWAITING_ROOT_REVIEW');
    const args = process.argv.slice(2);
    check(
        args.length === 4 &&
            args[0] === '--state' &&
            args[2] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[3]),
        'QUALITY_BUCKET_ARGUMENTS'
    );
    const root = workspaceRoot();
    const directory = path.join(
        root,
        'node_modules/.cache/vectorix/vectorix-m7c-quality-' + args[3]
    );
    const stat = fs.lstatSync(directory);
    check(
        stat.isDirectory() &&
            stat.uid === process.getuid() &&
            (stat.mode & 0o777) === 0o700 &&
            fs.realpathSync(directory) === directory &&
            args[1] === path.join(directory, 'state.json'),
        'QUALITY_BUCKET_PRIVATE_DIRECTORY'
    );
    const state = validateBucketState(
        privateJson(args[1], 128 * 1024),
        args[3]
    );
    const proofFile = path.join(directory, 'bucket-proof.json');
    check(!fs.existsSync(proofFile), 'QUALITY_BUCKET_REFUSES_EXISTING_PROOF');
    guard(root, args[3]);
    for (const key of Object.keys(process.env))
        if (!['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key))
            delete process.env[key];
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    process.env.AWS_CONFIG_FILE = '/dev/null';
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
    const native = await nativeApi(root, state);
    try {
        const proof = await initializeQualityBucket({
            state,
            ...native,
            checkpoint: async (value) => {
                const bytes = JSON.stringify(value) + '\n';
                check(
                    Buffer.byteLength(bytes) <= 16384,
                    'QUALITY_BUCKET_PROOF_CAP'
                );
                fs.writeFileSync(proofFile, bytes, { flag: 'wx', mode: 0o600 });
            },
        });
        console.log(JSON.stringify(proof));
    } finally {
        native.close();
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch((error) => {
        console.error(
            JSON.stringify({
                completed: false,
                diagnostic:
                    error instanceof QualityBucketError &&
                    /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
                        ? error.message
                        : 'QUALITY_BUCKET_SANITIZED_FAILURE',
            })
        );
        process.exitCode = 1;
    });
