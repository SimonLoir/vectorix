/** Guarded owned-fixture object export and restore; no resource action occurs on import. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import {
    ObjectGuardError,
    LIMITS,
    requireObject as check,
    canonical,
    sha256,
    validateState,
    validateFixture,
    validateKey,
    validateDestination,
    objectHeaders,
    validateObjectBytes,
    buildManifest,
    publicManifest,
    storedObjectContentType,
} from './m7c-object-manifest.mjs';

const STATIC_DRAFT_ONLY = false;
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const CACHE = path.join(ROOT, 'node_modules/.cache/vectorix');
const MODES = [
    'initialize-source',
    'export',
    'verify-source',
    'restore',
    'verify-target',
];

function privateDirectory(filename, create = false) {
    if (create) fs.mkdirSync(filename, { mode: 0o700 });
    const value = fs.lstatSync(filename);
    check(
        value.isDirectory() &&
            !value.isSymbolicLink() &&
            (value.mode & 0o777) === 0o700 &&
            value.uid === process.getuid(),
        'private-directory-mode-owner'
    );
    check(
        fs.realpathSync(filename) === filename &&
            filename.startsWith(CACHE + '/'),
        'private-directory-path'
    );
}
function readPrivate(filename, maximum) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const value = fs.fstatSync(descriptor);
        check(
            value.isFile() &&
                value.uid === process.getuid() &&
                (value.mode & 0o777) === 0o600 &&
                value.size <= maximum,
            'private-file-mode-size-owner'
        );
        const bytes = Buffer.alloc(value.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(
                descriptor,
                bytes,
                offset,
                bytes.length - offset,
                offset
            );
            check(count > 0, 'private-file-short-read');
            offset += count;
        }
        check(
            fs.fstatSync(descriptor).size === value.size,
            'private-file-changed'
        );
        return bytes;
    } finally {
        fs.closeSync(descriptor);
    }
}
function writePrivate(filename, bytes) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
function independentGuard(statePath, run, mode) {
    const environment = Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]])
    );
    const value = spawnSync(
        'python3',
        [
            fileURLToPath(new URL('./m7c-object-guard.py', import.meta.url)),
            '--state',
            statePath,
            '--run',
            run,
            '--mode',
            mode,
        ],
        {
            cwd: ROOT,
            env: environment,
            encoding: 'utf8',
            timeout: 10000,
            maxBuffer: 16384,
        }
    );
    check(
        value.status === 0 && !value.error,
        'independent-object-resource-guard-refused'
    );
    const result = JSON.parse(value.stdout);
    check(
        result.resourcesOwned === true && result.runId === run,
        'independent-object-resource-guard-response'
    );
}

/** Resolve the retained credential exactly as product reads do, inside a bounded read-only snapshot. */
async function catalogBindings(state, fixture, require) {
    const { tsImport } = await import(require.resolve('tsx/esm/api'));
    const dbRequire = createRequire(
        path.join(ROOT, 'packages/db/package.json')
    );
    const { PrismaClient } = await tsImport(
        pathToFileURL(path.join(ROOT, 'packages/db/src/index.ts')).href,
        import.meta.url
    );
    const { PrismaPg } = dbRequire('@prisma/adapter-pg');
    const { boundStorage } = await tsImport(
        pathToFileURL(
            path.join(
                ROOT,
                'packages/routers/rag/src/services/documents/storage.ts'
            )
        ).href,
        import.meta.url
    );
    const db = new PrismaClient({
        adapter: new PrismaPg({
            connectionString: state.environment.DATABASE_URL,
            connectionTimeoutMillis: 5000,
        }),
    });
    try {
        return await db.$transaction(
            async (tx) => {
                // Prisma cannot express read-only transaction mode or a server statement budget.
                await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
                await tx.$executeRawUnsafe(
                    "SET LOCAL statement_timeout = '10s'"
                );
                const organizations = await tx.organization.findMany({
                    select: { id: true },
                    orderBy: { id: 'asc' },
                    take: 3,
                });
                check(
                    canonical(organizations.map((row) => row.id)) ===
                        canonical([...fixture.organizationIds].sort()),
                    'exact-owned-organizations'
                );
                const documents = await tx.document.findMany({
                    select: { id: true, organizationId: true },
                    take: LIMITS.documents + 1,
                });
                check(
                    canonical(documents.map((row) => row.id).sort()) ===
                        canonical([...fixture.documentIds].sort()),
                    'exact-owned-documents'
                );
                const documentOrganizations = Object.fromEntries(
                    documents.map((row) => [row.id, row.organizationId])
                );
                const inFlight = await Promise.all([
                    tx.documentIngestion.count({
                        where: { status: { in: ['UPLOADING', 'PROCESSING'] } },
                    }),
                    tx.documentCleanup.count({
                        where: { status: 'PROCESSING' },
                    }),
                    tx.indexTask.count({ where: { status: 'PROCESSING' } }),
                    tx.embeddingWorkAttempt.count({
                        where: { state: { in: ['RESERVED', 'IN_FLIGHT'] } },
                    }),
                ]);
                check(
                    inFlight.every((value) => value === 0),
                    'quiesced-source-no-inflight'
                );
                const versions = await tx.documentVersion.findMany({
                    orderBy: { id: 'asc' },
                    take: LIMITS.versions + 1,
                    select: {
                        id: true,
                        organizationId: true,
                        documentId: true,
                        storageLocationId: true,
                        objectKey: true,
                        sha256: true,
                        byteSize: true,
                        mediaType: true,
                        contentState: true,
                        discardedAt: true,
                        extraction: {
                            select: {
                                id: true,
                                organizationId: true,
                                versionId: true,
                                storageLocationId: true,
                                objectKey: true,
                                byteSize: true,
                                extractorVersion: true,
                                discardedAt: true,
                            },
                        },
                    },
                });
                check(
                    versions.length > 0 && versions.length <= LIMITS.versions,
                    'bounded-owned-versions'
                );
                check(
                    versions.filter((row) => row.extraction).length <=
                        LIMITS.extractions,
                    'bounded-owned-extractions'
                );
                const locationIds = [
                    ...new Set(
                        versions.flatMap((row) => [
                            row.storageLocationId,
                            ...(row.extraction
                                ? [row.extraction.storageLocationId]
                                : []),
                        ])
                    ),
                ];
                check(
                    locationIds.length <= LIMITS.locations,
                    'bound-storage-location-count'
                );
                const locations = await tx.storageLocation.findMany({
                    where: { id: { in: locationIds } },
                    select: {
                        id: true,
                        organizationId: true,
                        credentialId: true,
                        fingerprint: true,
                        endpoint: true,
                        region: true,
                        bucket: true,
                        forcePathStyle: true,
                        credential: { select: { revision: true } },
                    },
                });
                check(
                    locations.length === locationIds.length,
                    'all-storage-locations-present'
                );
                const configs = new Map();
                for (const location of locations) {
                    check(
                        fixture.organizationIds.includes(
                            location.organizationId
                        ),
                        'location-owned-organization'
                    );
                    const config = await boundStorage(
                        tx,
                        location.organizationId,
                        location.id
                    );
                    validateDestination(state, location, config);
                    configs.set(location.id, config);
                }
                const rows = [];
                function bind(value, version, kind) {
                    const location = locations.find(
                        (row) => row.id === value.storageLocationId
                    );
                    check(
                        location &&
                            location.organizationId ===
                                version.organizationId &&
                            value.organizationId === version.organizationId &&
                            documentOrganizations[version.documentId] ===
                                version.organizationId,
                        'exact-binding-organization'
                    );
                    check(
                        value.byteSize >= 0n &&
                            value.byteSize <= BigInt(LIMITS.objectBytes),
                        'catalog-object-byte-cap'
                    );
                    rows.push({
                        kind,
                        id: value.id,
                        versionId: version.id,
                        organizationId: version.organizationId,
                        documentId: version.documentId,
                        storageLocationId: location.id,
                        storageFingerprint: location.fingerprint,
                        credentialId: location.credentialId,
                        credentialRevision:
                            location.credential?.revision ?? null,
                        credentialBinding:
                            location.credentialId === null
                                ? 'PLATFORM'
                                : 'ORGANIZATION',
                        endpoint: location.endpoint,
                        region: location.region,
                        bucket: location.bucket,
                        forcePathStyle: location.forcePathStyle,
                        key: value.objectKey,
                        expectedBytes: Number(value.byteSize),
                        catalogSha256:
                            kind === 'ORIGINAL' ? version.sha256 : null,
                        expectedContentType: storedObjectContentType(
                            kind,
                            value.objectKey
                        ),
                        requiredPresent:
                            kind === 'ORIGINAL'
                                ? version.contentState === 'AVAILABLE' &&
                                  version.discardedAt === null
                                : value.discardedAt === null,
                        contentState: version.contentState,
                        discardedAt: value.discardedAt?.toISOString() ?? null,
                        extractorVersion:
                            kind === 'EXTRACTION'
                                ? value.extractorVersion
                                : null,
                    });
                }
                for (const version of versions) {
                    bind(version, version, 'ORIGINAL');
                    if (version.extraction)
                        bind(version.extraction, version, 'EXTRACTION');
                }
                for (const binding of ['PLATFORM', 'ORGANIZATION'])
                    check(
                        rows.some(
                            (row) =>
                                row.kind === 'ORIGINAL' &&
                                row.credentialBinding === binding
                        ),
                        'both-storage-binding-branches-required'
                    );
                return { bindings: rows, configs, documentOrganizations };
            },
            { isolationLevel: 'RepeatableRead', timeout: 20000, maxWait: 5000 }
        );
    } finally {
        await db.$disconnect();
    }
}

/** Every SDK request is pinned to the owned loopback address, with bounded response streams and no redirects. */
async function storageRuntime(state, require) {
    const sdk = require('@aws-sdk/client-s3');
    const sdkRequire = createRequire(require.resolve('@aws-sdk/client-s3'));
    const { NodeHttpHandler } = sdkRequire('@smithy/node-http-handler');
    const deadline = Date.now() + 120000;
    const clients = [];
    const rootConfig = {
        endpoint: state.environment.VECTORIX_DEFAULT_S3_ENDPOINT,
        region: 'us-east-1',
        forcePathStyle: true,
        accessKeyId: state.infrastructureSecrets.s3Access,
        secretAccessKey: state.infrastructureSecrets.s3Secret,
    };
    function client(config) {
        check(
            config.endpoint === rootConfig.endpoint &&
                config.region === rootConfig.region &&
                config.forcePathStyle === true,
            'http-destination-policy'
        );
        const transport = new NodeHttpHandler({
            connectionTimeout: 2000,
            requestTimeout: 15000,
            throwOnRequestTimeout: true,
        });
        const handler = {
            async handle(request, options) {
                check(
                    request.protocol === 'http:' &&
                        request.hostname === '127.0.0.1' &&
                        Number(request.port) === state.ports.rustfs,
                    'http-owned-loopback-request'
                );
                const result = await transport.handle(request, options);
                if (
                    result.response.statusCode >= 300 &&
                    result.response.statusCode < 400
                ) {
                    result.response.body?.destroy();
                    throw new ObjectGuardError('object-redirect-refused');
                }
                if (result.response.body) {
                    let count = 0;
                    const bounded = new Transform({
                        transform(part, _encoding, callback) {
                            count += part.byteLength;
                            if (count > LIMITS.objectBytes)
                                callback(
                                    new ObjectGuardError('s3-response-byte-cap')
                                );
                            else callback(null, part);
                        },
                    });
                    const original = result.response.body;
                    original.on('error', (error) => bounded.destroy(error));
                    bounded.on('error', () => {
                        /* SDK consumption still observes the same stream error. */
                    });
                    bounded.on('close', () => {
                        if (!original.destroyed) original.destroy();
                    });
                    result.response.body = original.pipe(bounded);
                }
                return result;
            },
            destroy() {
                transport.destroy();
            },
            updateHttpClientConfig(key, value) {
                transport.updateHttpClientConfig(key, value);
            },
            httpHandlerConfigs() {
                return transport.httpHandlerConfigs();
            },
        };
        const value = new sdk.S3Client({
            endpoint: config.endpoint,
            region: config.region,
            forcePathStyle: true,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            maxAttempts: 1,
            followRegionRedirects: false,
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
            requestHandler: handler,
        });
        clients.push(value);
        return value;
    }
    const root = client(rootConfig);
    async function send(value, Command, input) {
        const remaining = deadline - Date.now();
        check(remaining > 0, 'object-operation-deadline');
        return value.send(new Command(input), {
            abortSignal: AbortSignal.timeout(Math.min(remaining, 15000)),
        });
    }
    async function buckets(create) {
        const listed = await send(root, sdk.ListBucketsCommand, {});
        const names = (listed.Buckets ?? []).map((row) => row.Name).sort();
        check(
            names.every((name) => state.buckets.includes(name)) &&
                names.length <= 2,
            'no-unknown-buckets'
        );
        for (const bucket of state.buckets) {
            if (!names.includes(bucket)) {
                check(create, 'owned-bucket-missing');
                await send(root, sdk.CreateBucketCommand, { Bucket: bucket });
            }
            const versioning = await send(
                root,
                sdk.GetBucketVersioningCommand,
                { Bucket: bucket }
            );
            check(
                versioning.Status === undefined &&
                    versioning.MFADelete === undefined,
                'versioned-bucket-backup-not-supported'
            );
            await anonymous(bucket);
        }
    }
    async function anonymous(bucket, key) {
        const remaining = deadline - Date.now();
        check(remaining > 0, 'object-operation-deadline');
        const url =
            rootConfig.endpoint +
            '/' +
            encodeURIComponent(bucket) +
            (key === undefined
                ? ''
                : '/' + key.split('/').map(encodeURIComponent).join('/'));
        const response = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(remaining, 5000)),
        });
        try {
            check(
                response.status === 401 || response.status === 403,
                'anonymous-object-access-not-denied'
            );
        } finally {
            void response.body?.cancel().catch(() => {});
        }
    }
    async function keys(fixture, documentOrganizations) {
        const result = [];
        for (const bucket of [...state.buckets].sort()) {
            let token;
            const seen = new Set();
            for (let page = 0; page < 16; page++) {
                const value = await send(root, sdk.ListObjectsV2Command, {
                    Bucket: bucket,
                    MaxKeys: Math.min(1000, LIMITS.objects - result.length + 1),
                    ...(token ? { ContinuationToken: token } : {}),
                });
                for (const row of value.Contents ?? []) {
                    check(
                        result.length < LIMITS.objects,
                        'object-list-count-cap'
                    );
                    validateKey(row.Key, fixture, documentOrganizations);
                    check(
                        Number.isSafeInteger(row.Size) &&
                            row.Size >= 0 &&
                            row.Size <= LIMITS.objectBytes,
                        'listed-object-size-cap'
                    );
                    result.push({ bucket, key: row.Key });
                }
                if (!value.IsTruncated) break;
                check(
                    typeof value.NextContinuationToken === 'string' &&
                        value.NextContinuationToken.length <= 4096 &&
                        !seen.has(value.NextContinuationToken),
                    'object-pagination-token'
                );
                seen.add(value.NextContinuationToken);
                token = value.NextContinuationToken;
                check(page < 15, 'object-pagination-cap');
            }
        }
        return result.sort((a, b) => {
            const left = a.bucket + '\0' + a.key,
                right = b.bucket + '\0' + b.key;
            return left < right ? -1 : left > right ? 1 : 0;
        });
    }
    async function get(value, bucket, key) {
        const head = await send(value, sdk.HeadObjectCommand, {
            Bucket: bucket,
            Key: key,
        });
        const descriptor = objectHeaders(head);
        const length = head.ContentLength;
        check(
            Number.isSafeInteger(length) &&
                length >= 0 &&
                length <= LIMITS.objectBytes,
            'head-object-byte-cap'
        );
        const response = await send(value, sdk.GetObjectCommand, {
            Bucket: bucket,
            Key: key,
        });
        check(
            response.ContentLength === length &&
                canonical(objectHeaders(response)) === canonical(descriptor),
            'head-get-metadata-drift'
        );
        check(
            response.Body &&
                typeof response.Body[Symbol.asyncIterator] === 'function',
            's3-readable-body-required'
        );
        const bytes = Buffer.alloc(length);
        let offset = 0;
        try {
            for await (const part of response.Body) {
                check(
                    part instanceof Uint8Array &&
                        offset + part.byteLength <= length,
                    'stream-object-byte-cap'
                );
                bytes.set(part, offset);
                offset += part.byteLength;
            }
        } finally {
            response.Body.destroy?.();
        }
        check(offset === length, 'object-stream-short-read');
        return {
            bytes,
            descriptor: validateObjectBytes(bytes, length, descriptor),
        };
    }
    async function inventory(fixture, documentOrganizations, onObject) {
        const entries = await keys(fixture, documentOrganizations),
            result = [];
        let total = 0;
        for (const [index, entry] of entries.entries()) {
            const value = await get(root, entry.bucket, entry.key);
            total += value.bytes.length;
            check(total <= LIMITS.totalBytes, 'object-total-byte-cap');
            const descriptor = {
                ...entry,
                blob: 'object-' + String(index).padStart(4, '0') + '.bin',
                ...value.descriptor,
            };
            if (onObject) onObject(descriptor, value.bytes);
            result.push(descriptor);
            await anonymous(entry.bucket, entry.key);
        }
        return result;
    }
    async function verifyBindings(snapshot, manifest) {
        const clientsByLocation = new Map();
        for (const binding of manifest.bindings) {
            if (binding.presence !== 'PRESENT') continue;
            let value = clientsByLocation.get(binding.storageLocationId);
            if (!value) {
                value = client(snapshot.configs.get(binding.storageLocationId));
                clientsByLocation.set(binding.storageLocationId, value);
            }
            const actual = await get(value, binding.bucket, binding.key);
            const expected = manifest.objects.find(
                (row) =>
                    row.bucket === binding.bucket && row.key === binding.key
            );
            check(
                actual.descriptor.sha256 === expected.sha256 &&
                    actual.descriptor.bytes === expected.bytes &&
                    canonical(actual.descriptor.metadata) ===
                        canonical(expected.metadata) &&
                    canonical(actual.descriptor.headers) ===
                        canonical(expected.headers),
                'retained-credential-read-mismatch'
            );
        }
    }
    async function put(row, bytes) {
        const fields = {
            contentType: 'ContentType',
            cacheControl: 'CacheControl',
            contentDisposition: 'ContentDisposition',
            contentEncoding: 'ContentEncoding',
            contentLanguage: 'ContentLanguage',
        };
        const headers = Object.fromEntries(
            Object.entries(fields)
                .filter(([key]) => row.headers[key] !== null)
                .map(([key, value]) => [value, row.headers[key]])
        );
        if (row.headers.expires !== null)
            headers.Expires = new Date(row.headers.expires);
        await send(root, sdk.PutObjectCommand, {
            Bucket: row.bucket,
            Key: row.key,
            Body: bytes,
            ContentLength: bytes.length,
            Metadata: row.metadata,
            ...headers,
        });
    }
    return {
        buckets,
        keys,
        inventory,
        verifyBindings,
        put,
        close() {
            for (const value of clients) value.destroy();
        },
    };
}

async function main() {
    check(!STATIC_DRAFT_ONLY, 'static-object-helper-not-execution-approved');
    const args = process.argv.slice(2);
    check(
        args.length === 6 &&
            args[0] === '--state' &&
            args[2] === '--run' &&
            args[4] === '--mode',
        'object-cli-shape'
    );
    const [statePath, run, mode] = [args[1], args[3], args[5]];
    check(
        /^[a-f0-9]{12}$/u.test(run) && MODES.includes(mode),
        'object-cli-run-mode'
    );
    const directory = path.join(CACHE, 'vectorix-m7c-restore-' + run);
    check(
        statePath === path.join(directory, 'state.json'),
        'exact-private-state-path'
    );
    privateDirectory(directory);
    const state = JSON.parse(readPrivate(statePath, 128 * 1024));
    validateState(state, run);
    independentGuard(statePath, run, mode);
    // Every consumer gets only this owned configuration; no .env/HOME/proxy/default SDK chain.
    for (const key of Object.keys(process.env))
        if (!['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key))
            delete process.env[key];
    Object.assign(process.env, state.environment, {
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    });
    const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
    let storage;
    try {
        if (mode === 'initialize-source') {
            storage = await storageRuntime(state, require);
            await storage.buckets(true);
            console.log(
                JSON.stringify({
                    formatVersion: 1,
                    initializedBuckets: state.buckets.length,
                })
            );
            return;
        }
        const fixture = JSON.parse(
            readPrivate(path.join(directory, 'fixture.json'), 128 * 1024)
        );
        validateFixture(state, fixture);
        const snapshot = await catalogBindings(state, fixture, require);
        const bundle = path.join(directory, 'bundle'),
            objectsDirectory = path.join(bundle, 'objects');
        privateDirectory(bundle);
        privateDirectory(objectsDirectory, mode === 'export');
        let previous;
        if (mode !== 'export') {
            previous = JSON.parse(
                readPrivate(
                    path.join(objectsDirectory, 'manifest.json'),
                    4 * 1024 * 1024
                )
            );
            const recomputed = buildManifest(
                state,
                fixture,
                snapshot.bindings,
                previous.objects,
                snapshot.documentOrganizations
            );
            check(
                canonical(recomputed) === canonical(previous),
                'restored-catalog-or-manifest-binding-mismatch'
            );
            check(
                fs.readdirSync(objectsDirectory).sort().join('\0') ===
                    [
                        'manifest.json',
                        ...previous.objects.map((row) => row.blob),
                    ]
                        .sort()
                        .join('\0'),
                'exact-private-object-files'
            );
            // Validate every local artifact before starting any PUT; no partial restore of a corrupt bundle.
            for (const row of previous.objects) {
                const bytes = readPrivate(
                    path.join(objectsDirectory, row.blob),
                    LIMITS.objectBytes
                );
                check(
                    bytes.length === row.bytes && sha256(bytes) === row.sha256,
                    'private-backup-object-hash'
                );
            }
        }
        storage = await storageRuntime(state, require);
        if (mode === 'restore') {
            await storage.buckets(true);
            check(
                (await storage.keys(fixture, snapshot.documentOrganizations))
                    .length === 0,
                'target-buckets-must-be-empty'
            );
            for (const row of previous.objects)
                await storage.put(
                    row,
                    readPrivate(
                        path.join(objectsDirectory, row.blob),
                        LIMITS.objectBytes
                    )
                );
        } else await storage.buckets(false);
        const inventory = await storage.inventory(
            fixture,
            snapshot.documentOrganizations,
            mode === 'export'
                ? (row, bytes) =>
                      writePrivate(path.join(objectsDirectory, row.blob), bytes)
                : undefined
        );
        const manifest = buildManifest(
            state,
            fixture,
            snapshot.bindings,
            inventory,
            snapshot.documentOrganizations
        );
        await storage.verifyBindings(snapshot, manifest);
        const manifestBytes = canonical(manifest) + '\n';
        check(
            Buffer.byteLength(manifestBytes) <= 4 * 1024 * 1024,
            'private-manifest-byte-cap'
        );
        if (mode === 'export')
            writePrivate(
                path.join(objectsDirectory, 'manifest.json'),
                manifestBytes
            );
        else
            check(
                canonical(previous) === canonical(manifest),
                'physical-object-or-catalog-restore-mismatch'
            );
        console.log(JSON.stringify(publicManifest(manifest)));
    } finally {
        storage?.close();
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        const diagnostic =
            error instanceof ObjectGuardError &&
            /^[a-z][a-z0-9-]{1,100}$/u.test(error.message)
                ? error.message
                : 'sanitized-object-step-failure';
        // Internal child protocol: the parent captures bounded stdout even on
        // exit one, validates this safe code, and rejects completed:false.
        console.log(JSON.stringify({ completed: false, diagnostic }));
        process.exitCode = 1;
    });
}
