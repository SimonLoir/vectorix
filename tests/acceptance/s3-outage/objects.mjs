/** Exact owned read-only S3 evidence. Importing never resolves an SDK or opens a connection. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import {
    ROOT,
    need,
    RecipeError,
    scenarioSpec,
    sameScope,
} from './private.mjs';

export const STATIC_DRAFT_ONLY = true;
export const OBJECT_LIMITS = Object.freeze({
    objectBytes: 65536,
    totalBytes: 262144,
    requests: 9,
    deadlineMs: 30000,
    getMs: 5000,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const hash = (value) =>
    typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);

/** The outage phase is database-only even after the draft execution flag is opened. */
export function assertOnlineObjectPhase(phase) {
    need(
        [
            'v1-ready',
            'v2-staged',
            'restored-before-retry',
            'v2-ready',
            'signed-out',
            'cleanup-ready',
            'cleanup-staged',
            'cleanup-restored-before-retry',
            'cleanup-complete',
            'cleanup-signed-out',
        ].includes(phase),
        'S3_OUTAGE_OBJECT_ONLINE_ADMISSION'
    );
}

/** A descriptor must belong to the already validated two-version snapshot, never to a supplied object path. */
export function assertObjectDescriptor(input, state, fixture, bindings) {
    const endpoint = `http://127.0.0.1:${state.ports.rustfs}`,
        env = state.environment;
    need(
        Array.isArray(bindings) &&
            bindings.length >= 1 &&
            bindings.length <= 2 &&
            bindings.every(
                (row) =>
                    id(row.documentId) &&
                    id(row.versionId) &&
                    [1, 2].includes(row.version) &&
                    hash(row.sha256) &&
                    Number.isSafeInteger(row.byteSize) &&
                    row.byteSize > 0 &&
                    row.byteSize <= OBJECT_LIMITS.objectBytes
            ),
        'S3_OUTAGE_OBJECT_BINDINGS'
    );
    const saved = bindings.find((row) => row.versionId === input.versionId);
    need(
        saved &&
            id(input.organizationId) &&
            input.organizationId === fixture.organization.id &&
            input.documentId === saved.documentId &&
            (['original', 'artifact'].includes(input.kind) ||
                (state.scenario === 'CLEANUP_V1' &&
                    saved.purged === true &&
                    input.kind === 'structuredArtifact')) &&
            input.location?.organizationId === input.organizationId &&
            input.location.credentialId === null &&
            input.location.endpoint === endpoint &&
            input.location.bucket === env.VECTORIX_DEFAULT_S3_BUCKET &&
            input.location.region === env.VECTORIX_DEFAULT_S3_REGION &&
            input.location.forcePathStyle === true &&
            input.byteSize === saved.byteSize &&
            input.expectedSha256 === saved.sha256,
        'S3_OUTAGE_OBJECT_SCOPE'
    );
    const key = `${input.organizationId}/${saved.documentId}/${saved.versionId}/${input.kind === 'original' ? 'original' : input.kind === 'artifact' ? 'text.txt' : 'extraction.json'}`;
    need(input.key === key, 'S3_OUTAGE_OBJECT_KEY');
    return key;
}

/** Bound a stream through its complete body; a response header timeout alone is insufficient. */
export async function readBoundedObjectBody(
    reader,
    { byteSize, expectedSha256, deadline, now = () => performance.now() }
) {
    need(
        Number.isSafeInteger(byteSize) &&
            byteSize > 0 &&
            byteSize <= OBJECT_LIMITS.objectBytes &&
            hash(expectedSha256),
        'S3_OUTAGE_OBJECT_BODY_INPUT'
    );
    const parts = [];
    let bytes = 0;
    try {
        while (true) {
            need(now() < deadline, 'S3_OUTAGE_OBJECT_DEADLINE');
            let timer;
            const next = await Promise.race([
                reader.read(),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new RecipeError('S3_OUTAGE_OBJECT_DEADLINE')
                            ),
                        Math.max(1, Math.ceil(deadline - now()))
                    );
                }),
            ]).finally(() => clearTimeout(timer));
            need(now() < deadline, 'S3_OUTAGE_OBJECT_DEADLINE');
            if (next.done) break;
            need(
                next.value instanceof Uint8Array && next.value.byteLength > 0,
                'S3_OUTAGE_OBJECT_BODY_TYPE'
            );
            bytes += next.value.byteLength;
            need(bytes <= byteSize, 'S3_OUTAGE_OBJECT_BODY_BOUND');
            parts.push(Buffer.from(next.value));
        }
        const output = Buffer.concat(parts);
        need(
            output.length === byteSize && sha(output) === expectedSha256,
            'S3_OUTAGE_OBJECT_BODY_SHA'
        );
        return output;
    } finally {
        try {
            void reader.cancel().catch(() => {});
        } catch {
            /* Preserve primary failure. */
        }
        try {
            reader.releaseLock();
        } catch {
            /* Timed-out read may still be pending. */
        }
    }
}

/** Only an admitted online observer may construct this SDK; the outage observer cannot call it. */
export function createReadOnlyObjectObserver({
    state,
    fixture,
    bindings,
    phase,
    admit,
}) {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_OBJECT_DRAFT_REVIEW_REQUIRED');
    assertOnlineObjectPhase(phase);
    need(typeof admit === 'function', 'S3_OUTAGE_OBJECT_ONLINE_ADMISSION');
    admit();
    const endpoint = `http://127.0.0.1:${state.ports.rustfs}`,
        env = state.environment;
    need(
        state.protocolVersion === 2 &&
            state.namespace === scenarioSpec(state.scenario).namespace &&
            sameScope(state, fixture) &&
            (state.scenario === 'CLEANUP_V1'
                ? phase.startsWith('cleanup-')
                : !phase.startsWith('cleanup-')) &&
            fixture.namespace === state.namespace &&
            fixture.runId === state.runId &&
            env.VECTORIX_DEFAULT_S3_ENDPOINT === endpoint &&
            env.VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE === 'true' &&
            env.VECTORIX_DEFAULT_S3_BUCKET ===
                `${scenarioSpec(state.scenario).objectPrefix}-${state.runId}` &&
            env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID ===
                `${scenarioSpec(state.scenario).objectPrefix}-${state.runId}`,
        'S3_OUTAGE_OBJECT_ENDPOINT'
    );
    const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
    const sdkEntry = fs.realpathSync(require.resolve('@aws-sdk/client-s3')),
        fromSdk = createRequire(sdkEntry);
    const handlerEntry = fs.realpathSync(
        fromSdk.resolve('@smithy/node-http-handler')
    );
    for (const [name, entry] of [
        ['@aws-sdk/client-s3', sdkEntry],
        ['@smithy/node-http-handler', handlerEntry],
    ])
        need(
            Object.values(state.inputs.runtime).some(
                (row) =>
                    row.name === name && entry.startsWith(row.root + path.sep)
            ),
            'S3_OUTAGE_OBJECT_PINNED_SDK'
        );
    const sdk = require('@aws-sdk/client-s3'),
        { NodeHttpHandler } = fromSdk('@smithy/node-http-handler');
    const transport = new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true,
    });
    const deadline = performance.now() + OBJECT_LIMITS.deadlineMs;
    const handler = {
        async handle(request, options) {
            need(
                request.protocol === 'http:' &&
                    request.hostname === '127.0.0.1' &&
                    Number(request.port) === state.ports.rustfs &&
                    ['HEAD', 'GET'].includes(request.method) &&
                    performance.now() < deadline,
                'S3_OUTAGE_OBJECT_REQUEST'
            );
            const result = await transport.handle(request, options);
            if (
                result.response.statusCode >= 300 &&
                result.response.statusCode < 400
            ) {
                result.response.body?.destroy();
                need(false, 'S3_OUTAGE_OBJECT_REDIRECT');
            }
            if (result.response.body) {
                const original = result.response.body;
                let bytes = 0;
                const bounded = new Transform({
                    transform(part, _encoding, callback) {
                        bytes += part.byteLength;
                        if (bytes > OBJECT_LIMITS.objectBytes)
                            callback(
                                new RecipeError(
                                    'S3_OUTAGE_OBJECT_RESPONSE_BOUND'
                                )
                            );
                        else callback(null, part);
                    },
                });
                original.on('error', () =>
                    bounded.destroy(
                        new RecipeError('S3_OUTAGE_OBJECT_RESPONSE')
                    )
                );
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
        region: env.VECTORIX_DEFAULT_S3_REGION,
        forcePathStyle: true,
        maxAttempts: 1,
        followRegionRedirects: false,
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: handler,
        credentials: {
            accessKeyId: env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID,
            secretAccessKey: env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY,
        },
    });
    const seen = new Set();
    let requests = 0,
        totalBytes = 0,
        originals = 0,
        artifacts = 0,
        absentArtifacts = 0,
        absentPurgedObjects = 0;
    async function send(Command, key, until) {
        need(
            ++requests <= OBJECT_LIMITS.requests &&
                performance.now() < until &&
                until <= deadline,
            'S3_OUTAGE_OBJECT_REQUEST_BOUND'
        );
        return client.send(
            new Command({ Bucket: env.VECTORIX_DEFAULT_S3_BUCKET, Key: key }),
            {
                abortSignal: AbortSignal.timeout(
                    Math.max(1, Math.ceil(until - performance.now()))
                ),
            }
        );
    }
    function claim(input) {
        const key = assertObjectDescriptor(input, state, fixture, bindings);
        need(
            !seen.has(key) && performance.now() < deadline,
            'S3_OUTAGE_OBJECT_DUPLICATE_OR_DEADLINE'
        );
        seen.add(key);
        return key;
    }
    return {
        async read(input) {
            const key = claim(input);
            let response;
            try {
                const head = await send(
                    sdk.HeadObjectCommand,
                    key,
                    Math.min(deadline, performance.now() + 5000)
                );
                const type =
                    input.kind === 'original'
                        ? 'application/octet-stream'
                        : 'text/plain; charset=utf-8';
                need(
                    head.$metadata?.httpStatusCode === 200 &&
                        head.ContentLength === input.byteSize &&
                        head.ContentType === type &&
                        head.Metadata?.sha256 === input.expectedSha256,
                    'S3_OUTAGE_OBJECT_HEAD'
                );
                const getDeadline = Math.min(
                    deadline,
                    performance.now() + OBJECT_LIMITS.getMs
                );
                response = await send(sdk.GetObjectCommand, key, getDeadline);
                need(
                    response.$metadata?.httpStatusCode === 200 &&
                        response.ContentLength === input.byteSize &&
                        response.ContentType === type &&
                        response.Metadata?.sha256 === input.expectedSha256 &&
                        response.Body,
                    'S3_OUTAGE_OBJECT_GET'
                );
                const bytes = await readBoundedObjectBody(
                    response.Body.transformToWebStream().getReader(),
                    {
                        byteSize: input.byteSize,
                        expectedSha256: input.expectedSha256,
                        deadline: getDeadline,
                    }
                );
                totalBytes += bytes.length;
                need(
                    totalBytes <= OBJECT_LIMITS.totalBytes,
                    'S3_OUTAGE_OBJECT_TOTAL_BOUND'
                );
                if (input.kind === 'original') originals++;
                else artifacts++;
                return { bytes, sha256: sha(bytes), byteSize: bytes.length };
            } catch (error) {
                response?.Body?.destroy();
                client.destroy();
                throw error;
            }
        },
        async absentArtifact(input) {
            need(
                input.kind === 'artifact' &&
                    bindings.find((row) => row.versionId === input.versionId)
                        ?.extractionPresent === false,
                'S3_OUTAGE_OBJECT_ABSENCE_SCOPE'
            );
            const key = claim(input);
            try {
                await send(
                    sdk.HeadObjectCommand,
                    key,
                    Math.min(deadline, performance.now() + 5000)
                );
            } catch (error) {
                need(
                    error?.$metadata?.httpStatusCode === 404,
                    'S3_OUTAGE_OBJECT_ABSENCE_UNCONFIRMED'
                );
                absentArtifacts++;
                return;
            }
            need(false, 'S3_OUTAGE_OBJECT_UNEXPECTED_ARTIFACT');
        },
        async absentPurged(input) {
            need(
                state.scenario === 'CLEANUP_V1' &&
                    ['cleanup-complete', 'cleanup-signed-out'].includes(
                        phase
                    ) &&
                    bindings.find((row) => row.versionId === input.versionId)
                        ?.purged === true,
                'S3_OUTAGE_OBJECT_PURGE_SCOPE'
            );
            const key = claim(input);
            try {
                await send(
                    sdk.HeadObjectCommand,
                    key,
                    Math.min(deadline, performance.now() + 5000)
                );
            } catch (error) {
                need(
                    error?.$metadata?.httpStatusCode === 404,
                    'S3_OUTAGE_OBJECT_PURGE_ABSENCE_UNCONFIRMED'
                );
                absentPurgedObjects++;
                return;
            }
            need(false, 'S3_OUTAGE_OBJECT_PURGED_OBJECT_PRESENT');
        },
        summary: () => ({
            originals,
            artifacts,
            absentArtifacts,
            absentPurgedObjects,
            requests,
            objectBytes: totalBytes,
            scope: 'EXACT_PLATFORM_BINDING_READ_ONLY',
        }),
        close: () => client.destroy(),
    };
}
