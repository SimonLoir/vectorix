/** Closed native session/curl setup and exact-source reads; no database writes or browser transfers. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    context,
    HERE,
    need,
    privateJson,
    privateBytes,
    writePrivate,
    receiptScope,
    sameScope,
    entryError,
} from './private.mjs';
import { runPrivateCurl } from './vector-curl.mjs';
import { PROFILE } from './vector-embedding.mjs';
export const STATIC_DRAFT_ONLY = true;
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export function parseVectorArgs(args, key, choices) {
    need(
        Array.isArray(args) &&
            args.length === 6 &&
            args[0] === '--run' &&
            /^[a-f\d]{12}$/u.test(args[1]) &&
            args[2] === '--scenario' &&
            args[3] === 'VECTOR_PROVISION_V1' &&
            args[4] === key &&
            choices.includes(args[5]),
        'S3_OUTAGE_VECTOR_ARGUMENTS'
    );
    return args[5];
}
export function readVectorOriginal(state) {
    const name = 's3-outage-v1.txt',
        fd = fs.openSync(
            path.join(HERE, 'fixtures', name),
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        );
    try {
        const info = fs.fstatSync(fd),
            bytes = Buffer.alloc(1025),
            length = fs.readSync(fd, bytes, 0, bytes.length, 0),
            pin = state.inputs.textFixtures[name];
        need(
            info.isFile() &&
                info.uid === process.getuid() &&
                !(info.mode & 0o002) &&
                length === info.size &&
                length <= 1024 &&
                pin.bytes === length &&
                sha(bytes.subarray(0, length)) === pin.sha256,
            'S3_OUTAGE_VECTOR_SOURCE_PIN'
        );
        return bytes.subarray(0, length);
    } finally {
        fs.closeSync(fd);
    }
}
export function multipartOriginal(bytes, requestId) {
    need(
        Buffer.isBuffer(bytes) &&
            bytes.length <= 1024 &&
            /^[a-f\d-]{36}$/u.test(requestId),
        'S3_OUTAGE_VECTOR_MULTIPART'
    );
    const boundary = 'vectorix-' + requestId;
    return {
        contentType: 'multipart/form-data; boundary=' + boundary,
        body: Buffer.concat([
            Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s3-outage-v1.txt"\r\nContent-Type: text/plain\r\n\r\n`
            ),
            bytes,
            Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
    };
}
/** Validate every exposed hit against the independently observed publication and immutable original. */
export function assertVectorSearch(value, binding, target, original) {
    need(
        value.generationId === target &&
            Array.isArray(value.results) &&
            value.results.length > 0 &&
            value.results.length <= 5,
        'S3_OUTAGE_VECTOR_SEARCH_GENERATION'
    );
    for (const row of value.results) {
        need(
            row.generationId === target &&
                row.publicationId === binding.expectedPublicationId &&
                row.documentId === binding.documentId &&
                row.version === 1 &&
                row.published === true &&
                Number.isSafeInteger(row.startOffset) &&
                Number.isSafeInteger(row.endOffset) &&
                row.startOffset >= 0 &&
                row.endOffset > row.startOffset &&
                row.endOffset <= original.toString('utf8').length &&
                row.text ===
                    original
                        .toString('utf8')
                        .slice(row.startOffset, row.endOffset),
            'S3_OUTAGE_VECTOR_SEARCH_SOURCE'
        );
        need(
            row.parentContext &&
                row.parentContext.startOffset >= 0 &&
                row.parentContext.endOffset > row.parentContext.startOffset &&
                row.parentContext.endOffset <=
                    original.toString('utf8').length &&
                row.parentContext.text ===
                    original
                        .toString('utf8')
                        .slice(
                            row.parentContext.startOffset,
                            row.parentContext.endOffset
                        ),
            'S3_OUTAGE_VECTOR_SEARCH_PARENT'
        );
    }
}
const VECTOR_MODES = [
    'prepare-g1',
    'rebuild-g2',
    'search-g1',
    'search-outage',
    'search-g2',
];
/** Journal only closed mode/ordinal/method/status before validation; never include a route or payload. */
export function observeVectorHttpAttempt({
    mode,
    ordinal,
    method,
    remainingMilliseconds,
    dispatch,
    record,
}) {
    need(
        VECTOR_MODES.includes(mode) &&
            Number.isSafeInteger(ordinal) &&
            ordinal >= 1 &&
            ordinal <= 81 &&
            ['GET', 'POST', 'PUT'].includes(method) &&
            typeof remainingMilliseconds === 'function' &&
            typeof dispatch === 'function' &&
            typeof record === 'function',
        'S3_OUTAGE_VECTOR_HTTP_JOURNAL_SCOPE'
    );
    const fields = { mode, ordinal, method };
    record({ ...fields, moment: 'BEFORE', status: null });
    let response,
        status = null,
        failed = false,
        failure;
    try {
        need(remainingMilliseconds() > 0, 'S3_OUTAGE_VECTOR_HTTP_BOUND');
        response = dispatch();
        need(
            Number.isInteger(response.status) &&
                response.status >= 200 &&
                response.status <= 599,
            'S3_OUTAGE_VECTOR_HTTP_JOURNAL_STATUS'
        );
        status = response.status;
    } catch (error) {
        failed = true;
        failure = error;
    }
    try {
        record({ ...fields, moment: 'AFTER', status });
    } catch (error) {
        if (!failed) {
            failed = true;
            failure = error;
        }
    }
    if (failed) throw failure;
    return response;
}
/** The same injected/native workflow enforces one mutation path and a confirmed finally sign-out. */
export async function executeVectorWorkflow({
    mode,
    request,
    fixture,
    bindings,
    original,
    recordFinalization = () => {},
}) {
    let signedIn = false,
        result,
        failed = false,
        failure;
    try {
        const login = await request('POST', '/api/auth/sign-in/email', {
            email: fixture.users.owner.email,
            password: fixture.users.owner.password,
        });
        signedIn = true;
        need(
            login.user?.id === fixture.users.owner.userId,
            'S3_OUTAGE_VECTOR_SESSION_USER'
        );
        await request('POST', '/api/auth/organization/set-active', {
            organizationId: fixture.organization.id,
        });
        const session = await request('GET', '/api/auth/get-session');
        need(
            session.user?.id === fixture.users.owner.userId &&
                session.session?.activeOrganizationId ===
                    fixture.organization.id,
            'S3_OUTAGE_VECTOR_SESSION_ORGANIZATION'
        );
        if (mode === 'prepare-g1') {
            const collection = await request(
                'POST',
                '/api/v1/admin/rag/collections',
                {
                    name: 'Vector outage synthetic fixture',
                    description:
                        'Synthetic protocol fixture; no model quality claim.',
                    profile: PROFILE,
                    grantCreatorRead: true,
                }
            );
            need(
                id(collection.id) &&
                    collection.configurationRevision === 1 &&
                    collection.configuration?.credentialId === null,
                'S3_OUTAGE_VECTOR_COLLECTION'
            );
            const document = await request(
                'POST',
                '/api/v1/admin/rag/documents/uploads',
                multipartOriginal(original, randomUUID())
            );
            need(
                id(document.id) && id(document.versionId),
                'S3_OUTAGE_VECTOR_DOCUMENT'
            );
            // Read-only native polling has its own finite count; no retry of a mutation.
            let ready = false;
            for (let i = 0; i < 30; i++) {
                const detail = await request(
                    'GET',
                    `/api/v1/admin/rag/documents/${document.id}/details`
                );
                if (detail.version?.status === 'READY') {
                    ready = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            need(ready, 'S3_OUTAGE_VECTOR_SOURCE_NOT_READY');
            await request(
                'PUT',
                `/api/v1/admin/rag/documents/${document.id}/collections/${collection.id}`,
                { attached: true }
            );
            const generation = await request(
                'POST',
                `/api/v1/admin/rag/collections/${collection.id}/index-generations`,
                { expectedRevision: 1, requestId: randomUUID() }
            );
            need(id(generation.generationId), 'S3_OUTAGE_VECTOR_GENERATION');
            let active = false;
            for (let i = 0; i < 30; i++) {
                const status = await request(
                    'GET',
                    `/api/v1/admin/rag/collections/${collection.id}/index-status`
                );
                if (
                    status.active?.id === generation.generationId &&
                    status.active.status === 'ACTIVE'
                ) {
                    active = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            need(active, 'S3_OUTAGE_VECTOR_G1_NOT_ACTIVE');
            result = {
                collectionId: collection.id,
                documentId: document.id,
                versionId: document.versionId,
                g1: generation.generationId,
                revision: 1,
                originalSha256: sha(original),
            };
        } else if (mode === 'rebuild-g2') {
            const accepted = await request(
                'POST',
                `/api/v1/admin/rag/collections/${bindings.collectionId}/index-rebuilds`,
                {
                    expectedRevision: bindings.revision,
                    expectedActiveGenerationId: bindings.g1,
                    requestId: randomUUID(),
                }
            );
            need(
                id(accepted.generationId) &&
                    accepted.generationId !== bindings.g1,
                'S3_OUTAGE_VECTOR_GENERATION'
            );
            result = { ...bindings, g2: accepted.generationId };
        } else {
            const target = mode === 'search-g2' ? bindings.g2 : bindings.g1;
            let publicationId = bindings.expectedPublicationId;
            for (const strategy of mode === 'search-outage'
                ? ['LEXICAL', 'HYBRID']
                : ['LEXICAL', 'VECTOR', 'HYBRID']) {
                const value = await request(
                    'POST',
                    `/api/v1/admin/rag/collections/${bindings.collectionId}/search`,
                    { query: 'recovery', topK: 5, strategy, filters: {} },
                    {
                        refusedVector:
                            mode === 'search-outage' && strategy === 'HYBRID',
                    }
                );
                if (mode === 'search-outage' && strategy === 'HYBRID') continue;
                publicationId ??= value.results?.[0]?.publicationId;
                need(id(publicationId), 'S3_OUTAGE_VECTOR_SEARCH_SOURCE');
                assertVectorSearch(
                    value,
                    { ...bindings, expectedPublicationId: publicationId },
                    target,
                    original
                );
                const hit = value.results[0];
                need(
                    typeof hit.source?.receipt === 'string' &&
                        hit.source?.receipt.length <= 4096,
                    'S3_OUTAGE_VECTOR_SOURCE_RECEIPT'
                );
                const preview = await request(
                    'POST',
                    `/api/v1/admin/rag/collections/${bindings.collectionId}/sources/preview`,
                    { receipt: hit.source?.receipt, offset: 0 }
                );
                need(
                    preview.version === 1 &&
                        preview.format === 'TEXT' &&
                        preview.text === original.toString('utf8') &&
                        preview.nextOffset === null,
                    'S3_OUTAGE_VECTOR_CANONICAL_PREVIEW'
                );
                const source = await request(
                    'POST',
                    `/api/v1/admin/rag/collections/${bindings.collectionId}/sources/original`,
                    { receipt: hit.source?.receipt },
                    { binary: true }
                );
                need(
                    source.equals(original),
                    'S3_OUTAGE_VECTOR_ORIGINAL_BYTES'
                );
            }
            result = {
                generationId: target,
                publicationId,
                strategies:
                    mode === 'search-outage'
                        ? ['LEXICAL', 'HYBRID_REFUSED_VECTOR_UNAVAILABLE']
                        : ['LEXICAL', 'VECTOR', 'HYBRID'],
                originalSha256: sha(original),
                syntheticQuality: 'NOT_MEASURED',
            };
        }
    } catch (error) {
        failed = true;
        failure = error;
    }
    const primaryFailureObserved = failed;
    let signOutConfirmed = false,
        signOutFailed = false;
    if (signedIn) {
        try {
            need(
                (await request('POST', '/api/auth/sign-out', {})).success ===
                    true,
                'S3_OUTAGE_VECTOR_SIGNOUT'
            );
            signOutConfirmed = true;
        } catch (error) {
            signOutFailed = true;
            if (!failed) {
                failed = true;
                failure = error;
            }
        }
    }
    try {
        recordFinalization({
            primaryFailureObserved,
            signOutAttempted: signedIn,
            signOutConfirmed,
            secondarySignOutFailure: primaryFailureObserved && signOutFailed,
        });
    } catch (error) {
        if (!failed) {
            failed = true;
            failure = error;
        }
    }
    if (failed) throw failure;
    return result;
}
async function main() {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_VECTOR_WORKFLOW_DRAFT_REVIEW_REQUIRED');
    const args = process.argv.slice(2),
        mode = parseVectorArgs(args, '--mode', VECTOR_MODES),
        purpose =
            mode === 'rebuild-g2'
                ? 'staged-observe'
                : mode === 'search-outage'
                  ? 'outage-observe'
                  : 'observe';
    const ctx = context(args.slice(0, 4), purpose),
        { state, directory, recheck } = ctx,
        fixture = privateJson(path.join(directory, 'fixture.json'), 16384);
    need(sameScope(state, fixture), 'S3_OUTAGE_VECTOR_FIXTURE_SCOPE');
    const bindings =
        mode === 'prepare-g1'
            ? null
            : privateJson(
                  path.join(
                      directory,
                      mode === 'rebuild-g2' || mode === 'search-g1'
                          ? 'vector-g1-bindings.json'
                          : 'vector-g2-bindings.json'
                  ),
                  16384
              );
    if (bindings)
        need(
            sameScope(state, bindings) &&
                id(bindings.g1) &&
                id(bindings.collectionId),
            'S3_OUTAGE_VECTOR_BINDING_SCOPE'
        );
    let expectedSearchProof;
    if (mode === 'search-outage' || mode === 'search-g2') {
        const name =
            mode === 'search-g2'
                ? 'observe-vector-g2-ready.json'
                : 'observe-vector-g1-ready.json';
        const proof = privateJson(path.join(directory, name), 32768),
            target = mode === 'search-g2' ? bindings.g2 : bindings.g1;
        need(
            sameScope(state, proof) &&
                proof.status === 'OBSERVED' &&
                proof.activeGenerationId === target,
            'S3_OUTAGE_VECTOR_SEARCH_BASELINE'
        );
        const publication = proof.manifests?.find(
            (row) => row.generationId === target
        );
        need(
            id(publication?.publicationId),
            'S3_OUTAGE_VECTOR_SEARCH_BASELINE'
        );
        bindings.expectedPublicationId = publication.publicationId;
        expectedSearchProof = [
            name,
            sha(privateBytes(path.join(directory, name), 32768)),
        ];
    }
    writePrivate(path.join(directory, `vector-${mode}-intent.json`), {
        ...receiptScope(state),
        status: 'ONE_SHOT_EFFECTS_UNKNOWN_NO_REPLAY',
    });
    const jar = new Map(),
        deadline = performance.now() + 180000;
    let calls = 0;
    const request = async (method, route, value, options = {}) => {
        const requestUntil =
            route === '/api/auth/sign-out'
                ? performance.now() + 10000
                : deadline;
        need(
            ++calls <= (route === '/api/auth/sign-out' ? 81 : 80) &&
                performance.now() < requestUntil,
            'S3_OUTAGE_VECTOR_HTTP_BOUND'
        );
        const multipart = value?.contentType?.startsWith('multipart/form-data;')
            ? value
            : null;
        const response = observeVectorHttpAttempt({
            mode,
            ordinal: calls,
            method,
            remainingMilliseconds: () => requestUntil - performance.now(),
            record: (event) =>
                writePrivate(
                    path.join(
                        directory,
                        `vector-${mode}-http-${calls}-${event.moment.toLowerCase()}.json`
                    ),
                    {
                        ...receiptScope(state),
                        ...event,
                        at: new Date().toISOString(),
                    }
                ),
            dispatch: () =>
                runPrivateCurl({
                    directory,
                    origin: `http://127.0.0.1:${state.ports.api}`,
                    route,
                    method,
                    curl: state.inputs.curl,
                    admit: () => {
                        need(
                            performance.now() < requestUntil,
                            'S3_OUTAGE_VECTOR_HTTP_BOUND'
                        );
                        recheck(
                            Math.max(
                                1,
                                Math.min(
                                    120000,
                                    Math.floor(requestUntil - performance.now())
                                )
                            )
                        );
                    },
                    remainingMilliseconds: () =>
                        requestUntil - performance.now(),
                    headers: [
                        ['Origin', `http://127.0.0.1:${state.ports.web}`],
                        ['Vectorix-CSRF', 'orpc'],
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
                        ...(value
                            ? [
                                  [
                                      'content-type',
                                      multipart?.contentType ??
                                          'application/json',
                                  ],
                              ]
                            : []),
                    ],
                    body: value
                        ? (multipart?.body ??
                          Buffer.from(JSON.stringify(value)))
                        : undefined,
                }),
        });
        for (const [name, line] of response.headers)
            if (name === 'set-cookie') {
                const pair = line.split(';', 1)[0],
                    at = pair.indexOf('=');
                need(
                    at > 0 &&
                        at < 128 &&
                        pair.length <= 8192 &&
                        !/[\x00-\x20\x7f]/u.test(pair),
                    'S3_OUTAGE_VECTOR_COOKIE'
                );
                const name = pair.slice(0, at),
                    content = pair.slice(at + 1);
                need(jar.has(name) || jar.size < 16, 'S3_OUTAGE_VECTOR_COOKIE');
                if (content) jar.set(name, content);
                else jar.delete(name);
            }
        let parsed;
        if (!options.binary || response.status !== 200) {
            try {
                parsed = JSON.parse(response.body.toString('utf8'));
            } catch {
                need(false, 'S3_OUTAGE_VECTOR_JSON');
            }
        }
        if (options.refusedVector) {
            need(
                response.status === 409 &&
                    parsed.code === 'CONFLICT' &&
                    parsed.data?.errorCode === 'VECTOR_UNAVAILABLE',
                'S3_OUTAGE_VECTOR_EXPECTED_REFUSAL'
            );
            return null;
        }
        need(
            response.status === 200,
            'S3_OUTAGE_VECTOR_HTTP_UNKNOWN_NO_REPLAY'
        );
        return options.binary ? response.body : parsed;
    };
    try {
        const result = await executeVectorWorkflow({
            mode,
            request,
            fixture,
            bindings,
            original: readVectorOriginal(state),
            recordFinalization: (finalization) =>
                writePrivate(
                    path.join(directory, `vector-${mode}-finalization.json`),
                    { ...receiptScope(state), mode, ...finalization }
                ),
        });
        recheck();
        need(
            !expectedSearchProof ||
                sha(
                    privateBytes(
                        path.join(directory, expectedSearchProof[0]),
                        32768
                    )
                ) === expectedSearchProof[1],
            'S3_OUTAGE_VECTOR_SEARCH_BASELINE_DRIFT'
        );
        need(performance.now() < deadline, 'S3_OUTAGE_VECTOR_HTTP_BOUND');
        const file =
            mode === 'prepare-g1'
                ? 'vector-g1-bindings.json'
                : mode === 'rebuild-g2'
                  ? 'vector-g2-bindings.json'
                  : `vector-${mode}-receipt.json`;
        writePrivate(path.join(directory, file), {
            ...receiptScope(state),
            ...result,
        });
        console.log(
            JSON.stringify({ ...receiptScope(state), completed: true, mode })
        );
    } finally {
        jar.clear();
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
