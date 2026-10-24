/** One-shot unattended native HTTP transfers. Library writes remain session-only. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    context,
    privateJson,
    privateBytes,
    receiptScope,
    sameScope,
    writePrivate,
    need,
    entryError,
    openFixturePrisma,
} from '../s3-outage/private.mjs';
import { assessReadKey, READ_PERMISSIONS } from './key-policy.mjs';
import { runPrivateCurl } from './curl.mjs';
export const STATIC_DRAFT_ONLY = true;

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(s);
/** Build the native OpenAPI multipart DTO; original bytes are not decoded/re-encoded. */
export function multipartDocument(bytes, version, previous) {
    need(
        Buffer.isBuffer(bytes) &&
            bytes.length <= 1024 &&
            [1, 2].includes(version),
        'S3_OUTAGE_TRANSFER_SOURCE'
    );
    const boundary = 'vectorix-' + randomUUID(),
        fields = {
            requestId: randomUUID(),
            ...(version === 2
                ? { expectedVersionId: previous, retentionDays: '7' }
                : {}),
        };
    need(version === 1 || id(previous), 'S3_OUTAGE_TRANSFER_SOURCE');
    const chunks = [];
    for (const [name, value] of Object.entries(fields))
        chunks.push(
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
            )
        );
    chunks.push(
        Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s3-outage-v${version}.txt"\r\nContent-Type: text/plain\r\n\r\n`
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    );
    return {
        body: Buffer.concat(chunks),
        contentType: 'multipart/form-data; boundary=' + boundary,
    };
}
/** Read at most 1025 bytes from a fixed no-follow fixture and require its prepared digest. */
export function readPinnedOriginal(state, version) {
    need([1, 2].includes(version), 'S3_OUTAGE_TRANSFER_FIXTURE_PIN');
    const name = `s3-outage-v${version}.txt`,
        file = new URL('../s3-outage/fixtures/' + name, import.meta.url),
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const info = fs.fstatSync(fd),
            pin = state.inputs.textFixtures[name];
        need(
            info.isFile() &&
                info.uid === process.getuid() &&
                (info.mode & 0o002) === 0 &&
                info.size > 0 &&
                info.size <= 1024,
            'S3_OUTAGE_TRANSFER_FIXTURE_PIN'
        );
        const buffer = Buffer.alloc(1025),
            length = fs.readSync(fd, buffer, 0, buffer.length, 0),
            bytes = buffer.subarray(0, length);
        need(
            length === info.size &&
                length === pin.bytes &&
                sha(bytes) === pin.sha256,
            'S3_OUTAGE_TRANSFER_FIXTURE_PIN'
        );
        return bytes;
    } finally {
        fs.closeSync(fd);
    }
}

function json(response) {
    try {
        return JSON.parse(response.body.toString('utf8'));
    } catch {
        need(false, 'S3_OUTAGE_TRANSFER_JSON');
    }
}
/** Reject unknown modes/scenarios/flags before context admission or any native work. */
export function parseTransferArgs(args) {
    need(
        Array.isArray(args) &&
            args.length === 6 &&
            args[0] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[1]) &&
            args[2] === '--scenario' &&
            args[3] === 'REDIS_V1' &&
            args[4] === '--mode' &&
            ['key', 'upload-v1', 'replace-v2', 'read-v1', 'read-v2'].includes(
                args[5]
            ),
        'S3_OUTAGE_TRANSFER_ARGUMENTS'
    );
    return {
        mode: args[5],
        purpose: args[5] === 'replace-v2' ? 'staged-observe' : 'observe',
    };
}

async function main() {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_TRANSFER_DRAFT_REVIEW_REQUIRED');
    const args = process.argv.slice(2),
        { mode, purpose } = parseTransferArgs(args),
        { state, run, directory, recheck } = context(args.slice(0, 4), purpose),
        fixture = privateJson(path.join(directory, 'fixture.json'), 16384);
    need(
        sameScope(state, fixture) &&
            fixture.namespace === state.namespace &&
            fixture.setup.apiKeys === 0,
        'S3_OUTAGE_TRANSFER_FIXTURE'
    );
    const started = performance.now(),
        jar = new Map(),
        origin = `http://127.0.0.1:${state.ports.api}`;
    let calls = 0,
        client,
        result,
        failure;
    writePrivate(path.join(directory, `transfer-${mode}-intent.json`), {
        ...receiptScope(state),
        mode,
        status: 'ONE_SHOT_ACCEPTANCE_UNKNOWN',
        at: new Date().toISOString(),
    });
    const keyFile = path.join(directory, 'redis-read-key.json'),
        keyProofFile = path.join(directory, 'redis-read-key-proof.json');
    const key = mode === 'key' ? null : privateJson(keyFile, 16384);
    if (key) {
        const proof = privateJson(keyProofFile, 16384);
        need(
            sameScope(state, proof) &&
                proof.id === key.id &&
                proof.keyFileSha256 === sha(privateBytes(keyFile, 16384)) &&
                proof.status === 'NATIVE_ISSUER_BOUND_READ_ONLY_KEY' &&
                proof.sessionSignedOut === true,
            'S3_OUTAGE_TRANSFER_KEY_SCOPE'
        );
    }
    if (key)
        need(
            sameScope(state, key) &&
                key.organizationId === fixture.organization.id &&
                key.issuerUserId === fixture.users.owner.userId &&
                same(key.permissions, READ_PERMISSIONS),
            'S3_OUTAGE_TRANSFER_KEY_SCOPE'
        );
    function request(
        route,
        method,
        body,
        contentType = 'application/json',
        auth = 'session',
        signOut = false
    ) {
        need(++calls <= 9, 'S3_OUTAGE_TRANSFER_CALL_BOUND');
        const ordinal = calls;
        writePrivate(
            path.join(directory, `transfer-${mode}-${ordinal}-before.json`),
            {
                ...receiptScope(state),
                mode,
                ordinal,
                at: new Date().toISOString(),
            }
        );
        const headers = [
            ['Vectorix-CSRF', 'orpc'],
            ['Vectorix-Expected-Organization-Id', fixture.organization.id],
            ...(auth === 'key'
                ? [['x-api-key', key.key]]
                : [
                      ['Origin', `http://127.0.0.1:${state.ports.web}`],
                      ...(jar.size
                          ? [
                                [
                                    'Cookie',
                                    [...jar]
                                        .map(([k, v]) => k + '=' + v)
                                        .join('; '),
                                ],
                            ]
                          : []),
                  ]),
            ...(body ? [['content-type', contentType]] : []),
        ];
        const response = runPrivateCurl({
            directory,
            curl: state.inputs.curl,
            origin,
            route,
            method,
            headers,
            body,
            admit: recheck,
            remainingMilliseconds: () =>
                signOut ? 10000 : 120000 - (performance.now() - started),
        });
        if (auth === 'session')
            for (const [name, value] of response.headers)
                if (name === 'set-cookie') {
                    const pair = value.split(';', 1)[0],
                        split = pair.indexOf('=');
                    need(
                        split > 0 &&
                            split < 128 &&
                            pair.length <= 8192 &&
                            !/[\r\n\0-\x20\x7f]/u.test(pair) &&
                            jar.size < 16,
                        'S3_OUTAGE_TRANSFER_COOKIE'
                    );
                    const cookieName = pair.slice(0, split),
                        cookieValue = pair.slice(split + 1);
                    if (cookieValue) jar.set(cookieName, cookieValue);
                    else jar.delete(cookieName);
                }
        writePrivate(
            path.join(directory, `transfer-${mode}-${ordinal}-after.json`),
            {
                ...receiptScope(state),
                mode,
                ordinal,
                status: response.status,
                bodyBytes: response.body.length,
                at: new Date().toISOString(),
            }
        );
        return response;
    }
    const auth = (route, body, signOut = false) => {
        const response = request(
            '/api/auth/' + route,
            route === 'get-session' ? 'GET' : 'POST',
            route === 'get-session'
                ? undefined
                : Buffer.from(JSON.stringify(body ?? {})),
            'application/json',
            'session',
            signOut
        );
        need(response.status === 200, 'S3_OUTAGE_TRANSFER_NATIVE_AUTH_REFUSED');
        return json(response);
    };
    try {
        const signed = auth('sign-in/email', {
            email: fixture.users.owner.email,
            password: fixture.users.owner.password,
        });
        need(
            signed.user?.id === fixture.users.owner.userId && jar.size > 0,
            'S3_OUTAGE_TRANSFER_OWNER'
        );
        auth('organization/set-active', {
            organizationId: fixture.organization.id,
        });
        const session = auth('get-session');
        need(
            session.user?.id === fixture.users.owner.userId &&
                session.session?.activeOrganizationId ===
                    fixture.organization.id,
            'S3_OUTAGE_TRANSFER_OWNER'
        );
        if (mode === 'key') {
            need(
                !fs.existsSync(keyFile) && !fs.existsSync(keyProofFile),
                'S3_OUTAGE_TRANSFER_NO_REPLAY'
            );
            const response = request(
                '/rpc/v1/admin/organization/apiKeys/create',
                'POST',
                Buffer.from(
                    JSON.stringify({
                        json: {
                            name: `Redis read ${run}`,
                            permissions: READ_PERMISSIONS,
                            collectionScopes: [],
                        },
                    })
                )
            );
            need(response.status === 200, 'S3_OUTAGE_TRANSFER_KEY_CREATION');
            const created = json(response).json;
            need(
                id(created?.id) &&
                    typeof created.key === 'string' &&
                    /^[A-Za-z0-9_-]{16,512}$/u.test(created.key),
                'S3_OUTAGE_TRANSFER_KEY_RESPONSE'
            );
            client = await openFixturePrisma(state, true);
            const metadata = await client.$transaction(
                async (tx) => {
                    need(
                        (await tx.apikey.count()) === 1,
                        'S3_OUTAGE_TRANSFER_KEY_COUNT'
                    );
                    return assessReadKey(
                        await tx.apikey.findUnique({
                            where: { id: created.id },
                            select: {
                                id: true,
                                configId: true,
                                name: true,
                                referenceId: true,
                                enabled: true,
                                expiresAt: true,
                                permissions: true,
                                vectorixLegacyFullAccess: true,
                            },
                        }),
                        await tx.apiKeyPrincipal.findMany({
                            take: 2,
                            select: {
                                keyId: true,
                                organizationId: true,
                                memberId: true,
                            },
                        }),
                        await tx.apiKeyCollectionScope.count(),
                        await tx.ragAuditLog.findMany({
                            where: { action: 'apiKey.create' },
                            take: 2,
                            select: {
                                id: true,
                                organizationId: true,
                                actorId: true,
                                actorType: true,
                                targetId: true,
                                action: true,
                                details: true,
                            },
                        }),
                        fixture,
                        created.id
                    );
                },
                {
                    isolationLevel: 'RepeatableRead',
                    maxWait: 1000,
                    timeout: 15000,
                }
            );
            result = { ...receiptScope(state), ...metadata, key: created.key };
        } else if (['upload-v1', 'replace-v2'].includes(mode)) {
            const version = mode === 'upload-v1' ? 1 : 2,
                bytes = readPinnedOriginal(state, version);
            const baseline =
                    version === 2
                        ? privateJson(
                              path.join(directory, 'observe-redis-ready.json'),
                              32768
                          )
                        : null,
                source = baseline?.faultEnrollmentAdmission,
                multipart = multipartDocument(
                    bytes,
                    version,
                    source?.versionId
                );
            if (baseline)
                need(
                    sameScope(state, baseline) &&
                        source.version === 1 &&
                        id(source.documentId),
                    'S3_OUTAGE_TRANSFER_BASELINE'
                );
            const route =
                    version === 1
                        ? '/api/v1/admin/rag/documents/uploads'
                        : `/api/v1/admin/rag/documents/${source.documentId}/replacements`,
                response = request(
                    route,
                    'POST',
                    multipart.body,
                    multipart.contentType
                );
            need(
                response.status === 200,
                'S3_OUTAGE_TRANSFER_WRITE_UNKNOWN_NO_RETRY'
            );
            const value = json(response);
            need(
                id(value.id) &&
                    id(value.versionId) &&
                    (!source || value.id === source.documentId),
                'S3_OUTAGE_TRANSFER_WRITE_RESPONSE'
            );
            result = {
                ...receiptScope(state),
                mode,
                documentId: value.id,
                versionId: value.versionId,
                version,
                originalSha256: sha(bytes),
                bytes: bytes.length,
                transport:
                    'NATIVE_SESSION_CURL_LIBRARY_WRITES_NOT_API_KEY_DELEGABLE',
            };
        } else {
            const version = mode === 'read-v2' ? 2 : 1,
                receipt = privateJson(
                    path.join(
                        directory,
                        `transfer-${version === 1 ? 'upload-v1' : 'replace-v2'}.json`
                    ),
                    16384
                );
            need(
                sameScope(state, receipt) && id(receipt.documentId),
                'S3_OUTAGE_TRANSFER_READ_SOURCE'
            );
            const bytes = readPinnedOriginal(state, version);
            const rejected = request(
                `/api/v1/admin/rag/documents/${receipt.documentId}/preview`,
                'GET',
                undefined,
                'application/json',
                'key'
            );
            need(
                rejected.status === 404,
                'S3_OUTAGE_TRANSFER_UNSCOPED_KEY_MUST_NOT_READ_LIBRARY'
            );
            const preview = request(
                    `/api/v1/admin/rag/documents/${receipt.documentId}/preview`,
                    'GET'
                ),
                value = json(preview);
            need(
                preview.status === 200 &&
                    value.version === version &&
                    value.text === bytes.toString('utf8') &&
                    value.nextOffset === null,
                'S3_OUTAGE_TRANSFER_PREVIEW'
            );
            const original = request(
                `/api/v1/admin/rag/documents/${receipt.documentId}/original`,
                'GET'
            );
            need(
                original.status === 200 && original.body.equals(bytes),
                'S3_OUTAGE_TRANSFER_DOWNLOAD'
            );
            result = {
                ...receiptScope(state),
                mode,
                documentId: receipt.documentId,
                versionId: receipt.versionId,
                version,
                bytes: bytes.length,
                sha256: sha(bytes),
                unscopedReadKeyStatus: 404,
                preview: 'EXACT_CANONICAL',
                download: 'EXACT_ORIGINAL',
                transport: 'NATIVE_SESSION_CURL',
            };
        }
    } catch (error) {
        failure = error;
    } finally {
        try {
            if (jar.size)
                need(
                    auth('sign-out', {}, true).success === true,
                    'S3_OUTAGE_TRANSFER_SIGNOUT'
                );
        } catch (error) {
            failure ??= error;
        }
        jar.clear();
        try {
            if (client) await client.$disconnect();
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw failure;
    recheck();
    need(result, 'S3_OUTAGE_TRANSFER_INCOMPLETE');
    if (mode === 'key') {
        writePrivate(keyFile, result);
        const { key: _secret, ...safe } = result;
        writePrivate(keyProofFile, {
            ...safe,
            keyFileSha256: sha(privateBytes(keyFile, 16384)),
            status: 'NATIVE_ISSUER_BOUND_READ_ONLY_KEY',
            sessionSignedOut: true,
        });
    } else writePrivate(path.join(directory, `transfer-${mode}.json`), result);
    console.log(
        JSON.stringify({
            completed: true,
            mode,
            runId: run,
            signOutConfirmed: true,
        })
    );
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
