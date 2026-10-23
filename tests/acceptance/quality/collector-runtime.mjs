/** Runtime adapters are imported only after explicit CLI arguments and independent ownership preflight. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sha256 } from './evaluate.mjs';
import { COLLECTOR_LIMITS } from './collector-protocol.mjs';
const need = (value, label) => {
    if (!value) throw new Error(label);
};

export function discoverWorkspace(directory) {
    for (let count = 0; count < 7; count++, directory = path.dirname(directory))
        if (
            fs.existsSync(path.join(directory, 'pnpm-workspace.yaml')) &&
            fs.existsSync(
                path.join(directory, 'packages/db/prisma/schema.prisma')
            )
        )
            return directory;
    throw new Error('COLLECTOR_WORKSPACE_NOT_FOUND');
}
export function privateDirectory(filename) {
    const value = fs.lstatSync(filename);
    need(
        value.isDirectory() &&
            !value.isSymbolicLink() &&
            value.uid === process.getuid() &&
            (value.mode & 0o777) === 0o700 &&
            fs.realpathSync(filename) === filename,
        'COLLECTOR_PRIVATE_DIRECTORY'
    );
}
export function readPrivate(filename, maximum) {
    const handle = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const value = fs.fstatSync(handle);
        need(
            value.isFile() &&
                value.uid === process.getuid() &&
                (value.mode & 0o777) === 0o600 &&
                value.size <= maximum,
            'COLLECTOR_PRIVATE_FILE'
        );
        const result = fs.readFileSync(handle);
        need(result.length <= maximum, 'COLLECTOR_PRIVATE_BYTE_CAP');
        return result;
    } finally {
        fs.closeSync(handle);
    }
}
export function privateCheckpoint(filename, value, exclusive = false) {
    const bytes = JSON.stringify(value) + '\n';
    need(
        Buffer.byteLength(bytes) <= COLLECTOR_LIMITS.captureBytes,
        'COLLECTOR_CHECKPOINT_CAP'
    );
    const target = exclusive ? filename : filename + '.next';
    const handle = fs.openSync(
        target,
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(handle, bytes);
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
    if (!exclusive) {
        if (fs.existsSync(filename)) {
            const saved = fs.lstatSync(filename);
            need(
                saved.isFile() &&
                    !saved.isSymbolicLink() &&
                    saved.uid === process.getuid() &&
                    (saved.mode & 0o777) === 0o600,
                'COLLECTOR_EXISTING_CHECKPOINT'
            );
        }
        fs.renameSync(target, filename);
    }
}
export function guardResources(root, script, statePath, run) {
    const env = Object.fromEntries(
        ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]])
    );
    const result = spawnSync(
        'python3',
        [script, '--state', statePath, '--run', run],
        { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 16384 }
    );
    need(
        result.status === 0 && !result.error,
        'COLLECTOR_INDEPENDENT_GUARD_REFUSED'
    );
    const proof = JSON.parse(result.stdout);
    need(
        proof.runId === run &&
            proof.resourceOwnership === true &&
            proof.syntheticCatalog === true &&
            proof.databaseReadOnly === true,
        'COLLECTOR_GUARD_PROOF'
    );
}

/** Count actual decoded bytes, bound contiguous allocation, cancel on refusal and retain transport headers. */
export async function boundHttpResponse(response) {
    const cancel = () => {
        void response.body?.cancel().catch(() => {});
    };
    if (response.status >= 300 && response.status < 400) {
        cancel();
        throw new Error('COLLECTOR_HTTP_REDIRECT');
    }
    const advertised = response.headers.get('content-length');
    if (
        advertised !== null &&
        (!/^\d+$/u.test(advertised) ||
            Number(advertised) > COLLECTOR_LIMITS.responseBytes)
    ) {
        cancel();
        throw new Error('COLLECTOR_RESPONSE_DECLARED_CAP');
    }
    const reader = response.body?.getReader();
    let buffer = Buffer.alloc(0),
        used = 0;
    try {
        if (reader)
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                need(
                    part.value instanceof Uint8Array &&
                        used + part.value.length <=
                            COLLECTOR_LIMITS.responseBytes,
                    'COLLECTOR_RESPONSE_ACTUAL_CAP'
                );
                const next = used + part.value.length;
                if (next > buffer.length) {
                    const grown = Buffer.alloc(
                        Math.min(
                            COLLECTOR_LIMITS.responseBytes,
                            Math.max(65536, next, buffer.length * 2)
                        )
                    );
                    grown.set(buffer.subarray(0, used));
                    buffer = grown;
                }
                buffer.set(part.value, used);
                used = next;
            }
    } finally {
        if (reader) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }
    const headers = new Headers(response.headers);
    // Fetch already decoded Content-Encoding; replay exact decoded bytes with truthful headers.
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(
        [101, 204, 205, 304].includes(response.status)
            ? null
            : buffer.subarray(0, used),
        { status: response.status, statusText: response.statusText, headers }
    );
}

/** Bound every actual response and prohibit redirects or an outbound URL outside the pinned API origin. */
export async function normalApiTransport(root, state, bootstrap) {
    const require = createRequire(path.join(root, 'apps/api/package.json'));
    const { createORPCClient } = await import(require.resolve('@orpc/client'));
    const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
    const jars = new Map(
        Object.keys(bootstrap.users).map((role) => [role, new Map()])
    );
    const statuses = new Map();
    const sessionHeaders = (role) => ({
        origin: state.webOrigin,
        cookie: [...jars.get(role)]
            .map(([key, value]) => key + '=' + value)
            .join('; '),
    });
    async function boundedFetch(request, init, role) {
        const original =
                request instanceof Request
                    ? request
                    : new Request(request, init),
            url = new URL(original.url);
        need(
            url.origin === state.apiOrigin &&
                (url.pathname.startsWith('/rpc/v1/') ||
                    url.pathname.startsWith('/api/auth/')),
            'COLLECTOR_HTTP_DESTINATION'
        );
        const abort = AbortSignal.timeout(40000);
        const signal = original.signal
            ? AbortSignal.any([original.signal, abort])
            : abort;
        const response = await fetch(
            new Request(original, { redirect: 'manual', signal })
        );
        statuses.set(role, response.status);
        return await boundHttpResponse(response);
    }
    const clients = new Map(
        Object.keys(bootstrap.users).map((role) => [
            role,
            createORPCClient(
                new RPCLink({
                    url: state.apiOrigin + '/rpc/v1',
                    headers: () => sessionHeaders(role),
                    fetch: (request, init) => boundedFetch(request, init, role),
                })
            ),
        ])
    );
    async function auth(role, operation, body) {
        need(
            ['sign-in/email', 'organization/set-active', 'sign-out'].includes(
                operation
            ),
            'COLLECTOR_AUTH_OPERATION'
        );
        const response = await boundedFetch(
            new Request(state.apiOrigin + '/api/auth/' + operation, {
                method: 'POST',
                headers: {
                    ...sessionHeaders(role),
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
            }),
            undefined,
            role
        );
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0],
                separator = pair.indexOf('=');
            need(
                separator > 0 &&
                    separator < 128 &&
                    pair.length <= 8192 &&
                    jars.get(role).size < 16,
                'COLLECTOR_COOKIE_BOUND'
            );
            jars.get(role).set(
                pair.slice(0, separator),
                pair.slice(separator + 1)
            );
        }
        need(response.ok, 'COLLECTOR_SYNTHETIC_AUTH_REFUSED');
        return await response.json();
    }
    return {
        async signIn() {
            for (const [role, user] of Object.entries(bootstrap.users)) {
                const value = await auth(role, 'sign-in/email', {
                    email: user.email,
                    password: user.password,
                });
                need(
                    value.user?.id === user.userId &&
                        value.user?.email === user.email,
                    'COLLECTOR_AUTH_IDENTITY'
                );
                await auth(role, 'organization/set-active', {
                    organizationId: user.organizationId,
                });
            }
        },
        async call(role, operation, input) {
            need(
                clients.has(role) &&
                    /^(documents|collections|indexing)\.[A-Za-z]+$/u.test(
                        operation
                    ),
                'COLLECTOR_RPC_OPERATION'
            );
            const [section, action] = operation.split('.');
            statuses.delete(role);
            return await clients.get(role).admin.rag[section][action](input);
        },
        observedStatus: (role) => statuses.get(role),
        async close() {
            for (const [role, cookies] of jars) {
                if (cookies.size) {
                    try {
                        await auth(role, 'sign-out', {});
                    } catch {
                        /* Cleanup does not change recorded quality outcomes. */
                    }
                }
                cookies.clear();
            }
        },
    };
}

/** Metadata-only independent evidence; the only SQL sets read-only mode and a statement budget. */
export async function generationObserver(root, state, recheckResources) {
    const require = createRequire(path.join(root, 'apps/api/package.json'));
    const { tsImport } = await import(require.resolve('tsx/esm/api'));
    process.env.DATABASE_URL = state.environment.DATABASE_URL;
    const { PrismaClient } = await tsImport(
        pathToFileURL(path.join(root, 'packages/db/src/index.ts')).href,
        import.meta.url
    );
    const { PrismaPg } = createRequire(
        path.join(root, 'packages/db/package.json')
    )('@prisma/adapter-pg');
    const db = new PrismaClient({
        adapter: new PrismaPg({
            connectionString: state.environment.DATABASE_URL,
            connectionTimeoutMillis: 5000,
        }),
    });
    return {
        async observe({ organizationId, collectionId, generationId }) {
            recheckResources();
            return await db.$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
                    await tx.$executeRawUnsafe(
                        "SET LOCAL statement_timeout = '5s'"
                    );
                    const row = await tx.indexGeneration.findFirst({
                        where: {
                            id: generationId,
                            organizationId,
                            collectionId,
                        },
                        include: {
                            configuration: true,
                            collection: {
                                select: { activeGenerationId: true },
                            },
                            publications: {
                                where: { status: 'PUBLISHED' },
                                take: 25,
                                select: {
                                    id: true,
                                    documentId: true,
                                    sourceVersionId: true,
                                    sourceVersion: {
                                        select: {
                                            version: true,
                                            sha256: true,
                                            contentState: true,
                                            discardedAt: true,
                                        },
                                    },
                                },
                            },
                        },
                    });
                    need(
                        row?.status === 'ACTIVE' &&
                            row.collection.activeGenerationId === row.id &&
                            row.publications.length === 24,
                        'COLLECTOR_OBSERVED_ACTIVE_GENERATION'
                    );
                    const config = row.configuration,
                        snapshot = row.capabilitySnapshot;
                    need(
                        config.provider === 'OLLAMA' &&
                            Buffer.byteLength(JSON.stringify(snapshot)) <=
                                16384 &&
                            snapshot?.provider === 'OLLAMA' &&
                            snapshot.digest === row.modelIdentity &&
                            snapshot.model === config.model &&
                            snapshot.dimensions === config.dimensions &&
                            snapshot.preset === config.embeddingPreset,
                        'COLLECTOR_SAVED_CAPABILITY_IDENTITY'
                    );
                    need(
                        row.publications.every(
                            (pub) =>
                                pub.sourceVersion.version === 1 &&
                                pub.sourceVersion.contentState ===
                                    'AVAILABLE' &&
                                pub.sourceVersion.discardedAt === null
                        ),
                        'COLLECTOR_OBSERVED_SOURCE_VERSION'
                    );
                    const profile = {
                        ...config.chunking,
                        parentChild: config.parentChild,
                        indexType: config.indexType,
                        preparation: config.preparation,
                        metadataFields: config.metadataFields,
                    };
                    return {
                        organizationId,
                        collectionId,
                        generationId,
                        configurationRevision: row.configurationRevision,
                        chunkerVersion: row.chunkerVersion,
                        parentContextVersion: row.parentContextVersion,
                        modelIdentity: row.modelIdentity,
                        capabilitySnapshotSha256: sha256(
                            JSON.stringify(snapshot)
                        ),
                        provider: config.provider,
                        model: config.model,
                        dimensions: config.dimensions,
                        embeddingPreset: config.embeddingPreset,
                        contextTokens: snapshot.contextTokens,
                        profile,
                        endpointIsOwned:
                            config.endpoint.replace(/\/$/u, '') ===
                            state.environment.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
                        publications: row.publications.map((pub) => ({
                            id: pub.id,
                            documentId: pub.documentId,
                            sourceVersionId: pub.sourceVersionId,
                            version: pub.sourceVersion.version,
                            originalSha256: pub.sourceVersion.sha256,
                        })),
                    };
                },
                {
                    isolationLevel: 'RepeatableRead',
                    timeout: 10000,
                    maxWait: 5000,
                }
            );
        },
        close: () => db.$disconnect(),
    };
}
