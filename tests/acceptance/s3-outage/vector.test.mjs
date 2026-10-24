import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { receiptScope, sameScope, scenarioSpec } from './private.mjs';
import {
    syntheticResponse,
    admitSyntheticConnection,
    syntheticVector,
    PROFILE,
    MODEL,
    MODEL_DIGEST,
    STATIC_DRAFT_ONLY as providerDraft,
} from './vector-embedding.mjs';
import {
    sha,
    executeVectorWorkflow,
    assertVectorSearch,
    parseVectorArgs,
    multipartOriginal,
    STATIC_DRAFT_ONLY as workflowDraft,
} from './vector-workflow.mjs';
import {
    assertCurlRoute,
    parseCurlResponse,
    runPrivateCurl,
    STATIC_DRAFT_ONLY as curlDraft,
} from './vector-curl.mjs';
import {
    assessVectorSnapshot,
    assertVectorContinuity,
    validateVectorTrace,
} from './vector-observation.mjs';
import { readVectorSnapshot, readPhysicalVector } from './vector-snapshot.mjs';
import {
    finalizeVectorObservation,
    STATIC_DRAFT_ONLY as observerDraft,
} from './vector-observe.mjs';

const runId = '012345abcdef',
    g1 = '11111111-1111-4111-8111-111111111111',
    g2 = '22222222-2222-4222-8222-222222222222';
const original = Buffer.from('recovery fixture'),
    sourceSha = sha(original),
    now = new Date('2026-10-24T10:00:00.000Z');
const state = {
    scenario: 'VECTOR_PROVISION_V1',
    protocolVersion: 2,
    runId,
    environment: { VECTORIX_DEFAULT_OLLAMA_ENDPOINT: 'http://127.0.0.1:17000' },
    inputs: {
        textFixtures: {
            's3-outage-v1.txt': { bytes: original.length, sha256: sourceSha },
        },
    },
};
const fixture = {
    ...receiptScope(state),
    users: {
        owner: {
            userId: 'owner',
            email: 'owner@example.test',
            password: 'synthetic-only',
        },
    },
    organization: { id: 'org' },
    membershipSnapshot: [
        {
            id: 'member',
            organizationId: 'org',
            userId: 'owner',
            role: 'owner',
            createdAt: now,
        },
    ],
};
const binding = {
    ...receiptScope(state),
    g1,
    g2,
    documentId: 'doc',
    versionId: 'version',
    collectionId: 'collection',
    revision: 1,
    originalSha256: sourceSha,
};
const plan = {
    ordinal: 0,
    start: 0,
    end: 16,
    text: 'recovery fixture',
    sourceSpans: [
        {
            source: { kind: 'text', index: 0, start: 0, end: 16 },
            start: 0,
            end: 16,
        },
    ],
};
const layout = {
    children: [plan],
    parents: [{ ...plan, ordinal: 1 }],
    childParentOrdinals: [1],
};
function snapshot(phase) {
    const final = ['vector-g2-ready', 'vector-signed-out'].includes(phase),
        hasG2 = phase !== 'vector-g1-ready';
    const generations = [g1, ...(hasG2 ? [g2] : [])];
    const candidates = generations.map((generationId, i) => ({
        id: 'pub' + i,
        generationId,
        documentId: 'doc',
        sourceVersionId: 'version',
        extractionId: 'extraction',
        status: i && !final ? 'STAGING' : 'PUBLISHED',
        chunkCount: i && !final ? 0 : 1,
        materializedChunks: i && !final ? 0 : 1,
        manifestHash: null,
        vectorSealedAt: i && !final ? null : now,
        publishedAt: i && !final ? null : now,
    }));
    const chunks = candidates
        .filter((p) => p.status === 'PUBLISHED')
        .flatMap((p) =>
            [0, 1].map((ordinal) => ({
                id: p.id + '-' + ordinal,
                generationId: p.generationId,
                indexedDocumentId: p.id,
                ordinal,
                kind: ordinal ? 'PARENT' : 'CHILD',
                parentId: ordinal ? null : p.id + '-1',
                text: plan.text,
                textHash: sha(plan.text),
                embeddingInputHash: ordinal ? null : sha(plan.text),
                startOffset: 0,
                endOffset: 16,
                sourceSpanCount: 1,
                sourceSpans: plan.sourceSpans,
            }))
        );
    for (const candidate of candidates)
        if (candidate.status === 'PUBLISHED')
            candidate.manifestHash = sha(
                JSON.stringify(
                    chunks
                        .filter(
                            (r) =>
                                r.indexedDocumentId === candidate.id &&
                                r.kind === 'CHILD'
                        )
                        .map((r) => [r.id, r.ordinal, r.textHash])
                )
            );
    const tasks = candidates.flatMap((p, i) =>
        ['PROVISION', 'INDEX_DOCUMENT'].map((kind) => ({
            id: p.id + '-' + kind,
            generationId: p.generationId,
            indexedDocumentId: kind === 'INDEX_DOCUMENT' ? p.id : null,
            kind,
            status:
                i && !final
                    ? kind === 'INDEX_DOCUMENT' || phase === 'vector-g2-staged'
                        ? 'PENDING'
                        : 'FAILED'
                    : 'COMPLETE',
            stage: 'COMPLETE',
            leaseEpoch: 1n,
            attempts:
                i && !final
                    ? kind === 'INDEX_DOCUMENT' || phase === 'vector-g2-staged'
                        ? 0
                        : 5
                    : 1,
            reservedChunks: 0,
            completedChunks: 0,
            errorCode:
                i &&
                !final &&
                kind === 'PROVISION' &&
                phase !== 'vector-g2-staged'
                    ? 'VECTOR_UNAVAILABLE'
                    : null,
            leasedUntil: null,
            availableAt: now,
            updatedAt: now,
        }))
    );
    return {
        quota: {
            originalBytes: String(original.length),
            extractionBytes: String(original.length),
            reservedBytes: '0',
        },
        observedAt: now,
        counts: {
            users: 1,
            organizations: 1,
            members: 1,
            documents: 1,
            versions: 1,
            extractions: 1,
            collections: 1,
            keys: 0,
            groups: 0,
            invitations: 0,
            credentials: 0,
            selections: 0,
            sessions: phase === 'vector-signed-out' ? 0 : 1,
        },
        user: {
            id: 'owner',
            email: 'owner@example.test',
            emailVerified: false,
            isSuperAdmin: false,
        },
        organization: { id: 'org', isActive: true },
        members: fixture.membershipSnapshot,
        collection: {
            id: 'collection',
            organizationId: 'org',
            configurationRevision: 1,
            activeGenerationId: final ? g2 : g1,
            contentSequence: 1n,
            deletedAt: null,
        },
        generations: generations.map((id, i) => ({
            id,
            organizationId: 'org',
            collectionId: 'collection',
            status: i
                ? final
                    ? 'ACTIVE'
                    : 'PROVISIONING'
                : final
                  ? 'RETIRED'
                  : 'ACTIVE',
            previousGenerationId: i ? g1 : null,
            configurationRevision: 1,
            vectorSchema: 'vector_collections',
            tableName: 'g_' + id.replaceAll('-', ''),
            destinationFingerprint: 'f'.repeat(64),
            modelIdentity: MODEL_DIGEST,
            capabilitySnapshot: { digest: MODEL_DIGEST, dimensions: 3 },
            projectedChunks: i && !final ? 0n : 1n,
            appliedSequence: 1n,
            chunkerVersion: 'structure-utf8-v1',
            parentContextVersion: 'parent-context-utf8-v1',
            configuration: {
                ...PROFILE,
                credentialId: null,
                credentialRevision: null,
                endpoint: state.environment.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
            },
        })),
        candidates,
        tasks,
        chunks,
        desired: candidates.map((p) => ({
            generationId: p.generationId,
            documentId: 'doc',
            desiredVersionId: 'version',
            desiredExtractionId: 'extraction',
            removedAt: null,
            publishedIndexedDocumentId: p.status === 'PUBLISHED' ? p.id : null,
        })),
        holds: candidates.map((p, i) => ({
            indexedDocumentId: p.id,
            versionId: 'version',
            releasedAt: null,
            state: !i && final ? 'RETIRED' : 'LIVE',
            retainUntil: !i && final ? new Date(now.getTime() + 1020000) : null,
        })),
        version: {
            id: 'version',
            status: 'READY',
            contentState: 'AVAILABLE',
            discardedAt: null,
            sha256: sourceSha,
            byteSize: BigInt(original.length),
        },
        extraction: {
            id: 'extraction',
            discardedAt: null,
            extractorVersion: 'utf8-text-v1',
            byteSize: BigInt(original.length),
        },
        liveClaims: 0,
        taskCount: tasks.length,
        usage: {
            activeChunks: 1n,
            retainedChunks: final ? 1n : 0n,
            reservedChunks: 0n,
        },
    };
}

test('new namespace and receipt scope reject other closed scenarios and missing roles before I/O', () => {
    assert.equal(
        scenarioSpec(state.scenario).namespace,
        'vectorix-m7c-vector-provision'
    );
    assert.equal(
        sameScope(state, { ...receiptScope(state), scenario: 'CLEANUP_V1' }),
        false
    );
    assert.equal(
        parseVectorArgs(
            ['--run', runId, '--scenario', state.scenario, '--phase', 'ready'],
            '--phase',
            ['ready']
        ),
        'ready'
    );
    for (const args of [
        [],
        ['--run', runId, '--scenario', 'CLEANUP_V1', '--phase', 'ready'],
        [
            '--run',
            runId,
            '--scenario',
            state.scenario,
            '--phase',
            'ready',
            'extra',
        ],
    ])
        assert.throws(() => parseVectorArgs(args, '--phase', ['ready']));
});
test('four vector entries are disabled and no-argument children refuse before any admission', () => {
    for (const flag of [providerDraft, workflowDraft, curlDraft, observerDraft])
        assert.equal(flag, true);
    for (const file of [
        'vector-embedding.mjs',
        'vector-workflow.mjs',
        'vector-observe.mjs',
    ]) {
        const result = spawnSync(
            process.execPath,
            [fileURLToPath(new URL(file, import.meta.url))],
            { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 }
        );
        assert.equal(result.status, 1);
        assert.match(result.stdout, /DRAFT_REVIEW_REQUIRED/u);
        assert.equal(result.stderr, '');
    }
    let calls = 0;
    assert.throws(
        () =>
            runPrivateCurl({}, () => {
                calls++;
            }),
        /DRAFT_REVIEW_REQUIRED/u
    );
    assert.equal(calls, 0);
});
test('synthetic native protocol has finite exact routes/model/vector response and no Gemma claim', () => {
    assert.equal(
        syntheticResponse('GET', '/api/tags', null).models[0].model,
        MODEL
    );
    const result = syntheticResponse('POST', '/api/embed', {
        model: MODEL,
        input: ['recovery fixture'],
        truncate: false,
    });
    assert.deepEqual(result.embeddings, [syntheticVector('recovery fixture')]);
    assert.equal(result.embeddings[0].length, 3);
    for (const [method, route, body] of [
        ['GET', '/api/tags?x=1', null],
        ['POST', '/api/pull', {}],
        ['POST', '/api/show', { model: 'embeddinggemma', verbose: false }],
        ['POST', '/api/embed', { model: MODEL, input: ['a'], truncate: true }],
        [
            'POST',
            '/api/embed',
            { model: MODEL, input: new Array(17).fill('a'), truncate: false },
        ],
        [
            'POST',
            '/api/embed',
            { model: MODEL, input: ['a'.repeat(4097)], truncate: false },
        ],
    ])
        assert.throws(() => syntheticResponse(method, route, body));
});
test('curl route/method closure excludes deletes, keys, credentials, retargeting and repaired URLs', () => {
    const origin = 'http://127.0.0.1:17000';
    assertCurlRoute(
        origin,
        '/api/v1/admin/rag/collections/c/index-rebuilds',
        'POST'
    );
    assertCurlRoute(
        origin,
        '/api/v1/admin/rag/documents/d/collections/c',
        'PUT'
    );
    for (const [url, route, method] of [
        [origin, '/api/v1/admin/rag/collections/c', 'DELETE'],
        [origin, '/rpc/v1/admin/organization/apiKeys/create', 'POST'],
        [origin, '/api/v1/admin/rag/credentials', 'POST'],
        ['http://localhost:17000', '/api/auth/sign-out', 'POST'],
        [origin, '/api/auth/sign-out?x=1', 'POST'],
    ])
        assert.throws(() => assertCurlRoute(url, route, method));
    assert.equal(
        parseCurlResponse(
            Buffer.from(
                'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nfixture'
            )
        ).body.toString(),
        'fixture'
    );
    assert.throws(() => parseCurlResponse(Buffer.alloc(81921)));
});
test('multipart preserves exact original bytes and native upload DTO without a filesystem path', () => {
    const multipart = multipartOriginal(
        original,
        '12345678-1234-4234-8234-123456789abc'
    );
    assert.equal(multipart.body.includes(original), true);
    assert.match(multipart.body.toString(), /filename="s3-outage-v1.txt"/u);
    assert.doesNotMatch(multipart.body.toString(), /\/home\/|retentionDays/u);
});
test('actual workflow confirms current session before rebuild and signs out after native admission failure', async () => {
    const calls = [];
    const request = async (method, route) => {
        calls.push([method, route]);
        if (route.endsWith('sign-in/email')) return { user: { id: 'owner' } };
        if (route.endsWith('get-session'))
            return {
                user: { id: 'owner' },
                session: { activeOrganizationId: 'org' },
            };
        if (route.endsWith('sign-out')) return { success: true };
        if (route.endsWith('index-rebuilds'))
            throw new Error('synthetic refusal');
        return {};
    };
    await assert.rejects(
        executeVectorWorkflow({
            mode: 'rebuild-g2',
            request,
            fixture,
            bindings: binding,
            original,
        }),
        /synthetic refusal/u
    );
    assert.equal(calls.length, 5);
    assert.equal(calls.at(-1)[1], '/api/auth/sign-out');
    calls.length = 0;
    await assert.rejects(
        executeVectorWorkflow({
            mode: 'rebuild-g2',
            request: async (method, route) =>
                route.endsWith('get-session')
                    ? { user: { id: 'foreign' } }
                    : request(method, route),
            fixture,
            bindings: binding,
            original,
        }),
        /SESSION_ORGANIZATION/u
    );
    assert.equal(
        calls.some((row) => row[1].endsWith('index-rebuilds')),
        false
    );
});
test('G1 stays active through staged/fifth-failure/restored states; only a complete G2 switches it', () => {
    for (const phase of [
        'vector-g1-ready',
        'vector-g2-staged',
        'vector-outage-failed',
        'vector-restored-before-retry',
        'vector-g2-ready',
        'vector-signed-out',
    ]) {
        const value = snapshot(phase),
            result = assessVectorSnapshot(
                value,
                phase,
                fixture,
                binding,
                state,
                layout
            );
        assert.equal(
            result.activeGenerationId,
            phase === 'vector-g2-ready' || phase === 'vector-signed-out'
                ? g2
                : g1
        );
        if (phase === 'vector-outage-failed') {
            value.collection.activeGenerationId = g2;
            assert.throws(
                () =>
                    assessVectorSnapshot(
                        value,
                        phase,
                        fixture,
                        binding,
                        state,
                        layout
                    ),
                /ACTIVE_POINTER/u
            );
        }
    }
});
test('foreign sources, sealed G2, holds, double accounting, live claims and sensitive account drift fail closed', () => {
    for (const mutate of [
        (v) => (v.version.sha256 = '0'.repeat(64)),
        (v) => (v.candidates[1].vectorSealedAt = now),
        (v) => (v.holds[0].state = 'RELEASED'),
        (v) => (v.usage.reservedChunks = 1n),
        (v) => (v.liveClaims = 1),
        (v) => (v.user.isSuperAdmin = true),
        (v) => (v.generations[1].configuration.credentialId = 'foreign'),
        (v) => (v.generations[1].projectedChunks = 1n),
        (v) => (v.members[0].role = 'admin'),
    ]) {
        const value = structuredClone(snapshot('vector-g2-staged'));
        mutate(value);
        assert.throws(() =>
            assessVectorSnapshot(
                value,
                'vector-g2-staged',
                fixture,
                binding,
                state,
                layout
            )
        );
    }
});
test('four actual indexing backoffs and fifth failure are required without clock or task rewriting', () => {
    let time = now.getTime();
    const rows = [1, 2, 3, 4, 5].map((attempts) => {
        const delay = 5000 * 2 ** attempts,
            row = {
                attempts,
                leaseEpoch: String(attempts),
                status: attempts === 5 ? 'FAILED' : 'PENDING',
                errorCode: 'VECTOR_UNAVAILABLE',
                leasedUntil: null,
                updatedAt: new Date(time).toISOString(),
                availableAt: new Date(time + delay).toISOString(),
            };
        time += delay;
        return row;
    });
    assert.deepEqual(
        validateVectorTrace(rows).backoffMilliseconds,
        [10000, 20000, 40000, 80000]
    );
    for (const mutate of [
        (r) => r.splice(1, 1),
        (r) => (r[2].availableAt = r[2].updatedAt),
        (r) => (r[4].attempts = 4),
        (r) => (r[3].leasedUntil = r[3].availableAt),
    ]) {
        const values = structuredClone(rows);
        mutate(values);
        assert.throws(() => validateVectorTrace(values));
    }
});
test('query builder bounds projections, scopes source IDs and never selects raw leases', async () => {
    const queries = [];
    const tx = new Proxy(
        {},
        {
            get(_target, name) {
                if (name === '$queryRawUnsafe')
                    return async (sql, ...params) => {
                        queries.push([sql, params]);
                        assert.match(sql, /LIMIT 33/u);
                        assert.match(sql, /LIMIT 64/u);
                        assert.deepEqual(params, ['org', [g1, g2]]);
                        return [];
                    };
                return new Proxy(
                    {},
                    {
                        get(_model, method) {
                            return async (query) => {
                                queries.push([name, method, query]);
                                assert.equal(
                                    query?.select?.leaseToken,
                                    undefined
                                );
                                if (query?.take) assert.ok(query.take <= 6);
                                return method === 'aggregate'
                                    ? {
                                          _sum: {
                                              byteSize: 0n,
                                              reservedBytes: 0n,
                                          },
                                      }
                                    : method === 'count'
                                      ? 0
                                      : method === 'findMany'
                                        ? []
                                        : null;
                            };
                        },
                    }
                );
            },
        }
    );
    await readVectorSnapshot(tx, fixture, binding);
    assert.equal(
        queries.some(
            (row) =>
                row[0] === 'indexTask' &&
                row[2]?.where?.leaseToken?.not === null
        ),
        true
    );
});
test('physical reader always releases and rolls back on wrong database before table I/O', async () => {
    const calls = [];
    const client = {
        query: async (query) => {
            const sql = typeof query === 'string' ? query : query.text;
            calls.push(sql);
            if (sql.startsWith('SELECT current_database'))
                return {
                    rows: [{ database: 'foreign', identity: 'x', version: 1 }],
                };
            return { rows: [] };
        },
        release: () => calls.push('release'),
    };
    await assert.rejects(
        readPhysicalVector(
            { connect: async () => client },
            { vectorDatabase: 'owned_test' },
            binding,
            { manifests: [] },
            { remainingMilliseconds: () => 1000 }
        ),
        /PHYSICAL_IDENTITY/u
    );
    assert.equal(calls.at(-2), 'ROLLBACK');
    assert.equal(calls.at(-1), 'release');
    assert.equal(
        calls.some((sql) => sql.includes('vx_generations')),
        false
    );
});
test('both reader closes drain before success and either rejection prevents the final guard/proof', async () => {
    for (const fails of [null, 'app', 'vector']) {
        const calls = [];
        const close = async (name) => {
            calls.push(name);
            if (fails === name) throw new Error('synthetic close');
        };
        const task = finalizeVectorObservation({
            app: { $disconnect: () => close('app') },
            pool: { end: () => close('vector') },
            recheck: () => calls.push('guard'),
            publish: () => calls.push('proof'),
        });
        if (fails) await assert.rejects(task, /READER_CLOSE/u);
        else await task;
        assert.deepEqual(
            calls,
            fails ? ['app', 'vector'] : ['app', 'vector', 'guard', 'proof']
        );
    }
});

test('native setup uses only one upload/create/start and confirms G1 ACTIVE before returning', async () => {
    const calls = [];
    const request = async (method, route, body) => {
        calls.push([method, route, body]);
        if (route.endsWith('sign-in/email')) return { user: { id: 'owner' } };
        if (route.endsWith('get-session'))
            return {
                user: { id: 'owner' },
                session: { activeOrganizationId: 'org' },
            };
        if (route.endsWith('sign-out')) return { success: true };
        if (route === '/api/v1/admin/rag/collections')
            return {
                id: 'collection',
                configurationRevision: 1,
                configuration: { credentialId: null },
            };
        if (route.endsWith('/uploads'))
            return { id: 'doc', versionId: 'version' };
        if (route.endsWith('/details'))
            return { version: { id: 'version', status: 'READY' } };
        if (route.endsWith('/index-generations')) return { generationId: g1 };
        if (route.endsWith('/index-status'))
            return { active: { id: g1, status: 'ACTIVE' } };
        return { success: true };
    };
    const result = await executeVectorWorkflow({
        mode: 'prepare-g1',
        request,
        fixture,
        original,
    });
    assert.equal(result.g1, g1);
    assert.equal(calls.filter((row) => row[1].endsWith('/uploads')).length, 1);
    assert.equal(
        calls.filter((row) => row[1].endsWith('/index-generations')).length,
        1
    );
    assert.deepEqual(
        calls.find((row) => row[1].endsWith('/collections/collection'))[2],
        { attached: true }
    );
    assert.equal(calls.at(-1)[1], '/api/auth/sign-out');
    assert.equal(
        calls.some((row) =>
            /credentials|apiKeys|grants|roles|DELETE/u.test(row[1])
        ),
        false
    );
});

test('every search row must belong to the observed generation/publication and exact source/parent spans', () => {
    const row = {
        generationId: g1,
        publicationId: 'pub0',
        documentId: 'doc',
        version: 1,
        published: true,
        startOffset: 0,
        endOffset: 16,
        text: original.toString(),
        parentContext: {
            startOffset: 0,
            endOffset: 16,
            text: original.toString(),
        },
    };
    const expected = { ...binding, expectedPublicationId: 'pub0' };
    assertVectorSearch(
        { generationId: g1, results: [row] },
        expected,
        g1,
        original
    );
    for (const mutate of [
        (r) => (r.generationId = g2),
        (r) => (r.publicationId = 'foreign'),
        (r) => (r.documentId = 'foreign'),
        (r) => (r.endOffset = 17),
        (r) => (r.parentContext.text = 'foreign'),
    ]) {
        const invalid = structuredClone(row);
        mutate(invalid);
        assert.throws(() =>
            assertVectorSearch(
                { generationId: g1, results: [invalid] },
                expected,
                g1,
                original
            )
        );
    }
});

test('the actual fixture connection gate bounds concurrent and lifetime sockets without counter wrap', () => {
    const counters = { connections: 0 };
    assert.equal(admitSyntheticConnection(counters, 16), false);
    for (let i = 1; i < 128; i++)
        assert.equal(admitSyntheticConnection(counters, 0), true);
    assert.equal(counters.connections, 128);
    assert.equal(admitSyntheticConnection(counters, 0), false);
    assert.equal(admitSyntheticConnection(counters, 0), false);
    assert.equal(counters.connections, 129);
    assert.throws(() => admitSyntheticConnection({ connections: Infinity }, 0));
});

function continuityObservation(phase, epoch, mutate = () => {}) {
    const value = structuredClone(snapshot(phase));
    const task = value.tasks.find(
        (item) => item.generationId === g2 && item.kind === 'PROVISION'
    );
    if (task) task.leaseEpoch = BigInt(epoch);
    mutate(value);
    const assessment = assessVectorSnapshot(
        value,
        phase,
        fixture,
        binding,
        state,
        layout
    );
    const physical =
        phase === 'vector-outage-failed'
            ? { scope: 'DB_ONLY_VECTOR_OFFLINE', requests: 0 }
            : {
                  identitySha256: 'a'.repeat(64),
                  generations: assessment.manifests.map((manifest) =>
                      manifest.manifestSha256
                          ? {
                                generationId: manifest.generationId,
                                provisioned: true,
                                children: manifest.children,
                                publicationId: manifest.publicationId,
                                sourceVersionId: manifest.sourceVersionId,
                                manifestSha256: manifest.manifestSha256,
                                destinationFingerprint:
                                    manifest.destinationFingerprint,
                            }
                          : {
                                generationId: manifest.generationId,
                                provisioned: false,
                            }
                  ),
              };
    return { phase, status: 'OBSERVED', ...assessment, physical };
}
function checkContinuity(current, baseline, previous) {
    return assertVectorContinuity({
        phase: current.phase,
        binding,
        assessment: current,
        physical: current.physical,
        baseline,
        previous,
    });
}

test('physical reader applies the remaining budget to every real query and never starts late I/O or COMMIT', async () => {
    const assessment = assessVectorSnapshot(
        snapshot('vector-g1-ready'),
        'vector-g1-ready',
        fixture,
        binding,
        state,
        layout
    );
    const manifest = assessment.manifests[0];
    const child = snapshot('vector-g1-ready').chunks.find(
        (row) => row.kind === 'CHILD'
    );
    for (const expiresAfter of [null, 'connect', 'identity', 'rows']) {
        let remaining = 10025;
        const calls = [];
        const client = {
            query: async (query) => {
                if (query === 'ROLLBACK') {
                    calls.push('ROLLBACK');
                    return { rows: [] };
                }
                assert.equal(typeof query, 'object');
                assert.equal(
                    query.query_timeout,
                    Math.min(10000, Math.floor(remaining))
                );
                assert.ok(query.query_timeout > 0);
                const sql = query.text;
                calls.push(sql);
                remaining -= 1000;
                if (sql.startsWith('SELECT current_database')) {
                    if (expiresAfter === 'identity') remaining = 0;
                    return {
                        rows: [
                            {
                                database: 'owned_test',
                                identity: 'fixture',
                                version: 1,
                            },
                        ],
                    };
                }
                if (sql.includes('vx_generations'))
                    return {
                        rows: [
                            {
                                organization_id: 'org',
                                collection_id: 'collection',
                                destination_fingerprint: 'f'.repeat(64),
                                state: 'READY',
                                shape: {
                                    dimensions: 3,
                                    metric: 'cosine',
                                    numericType: 'float32',
                                    indexType: 'HNSW',
                                },
                            },
                        ],
                    };
                if (sql.includes('vx_publications'))
                    return {
                        rows: [
                            {
                                id: manifest.publicationId,
                                document_id: binding.documentId,
                                source_version_id: binding.versionId,
                                expected_count: 1,
                                manifest_hash: manifest.manifestSha256,
                                state: 'SEALED',
                            },
                        ],
                    };
                if (sql.includes('SELECT chunk_id')) {
                    if (expiresAfter === 'rows') remaining = 0;
                    return {
                        rows: [
                            {
                                id: child.id,
                                ordinal: child.ordinal,
                                hash: child.textHash,
                                versionId: binding.versionId,
                                publicationId: manifest.publicationId,
                                documentId: binding.documentId,
                                generationId: g1,
                            },
                        ],
                    };
                }
                return { rows: [] };
            },
            release: () => calls.push('release'),
        };
        const operation = readPhysicalVector(
            {
                connect: async () => {
                    if (expiresAfter === 'connect') remaining = 0;
                    return client;
                },
            },
            { vectorDatabase: 'owned_test' },
            { ...binding, g2: null, organizationId: fixture.organization.id },
            assessment,
            { remainingMilliseconds: () => remaining }
        );
        if (expiresAfter) {
            await assert.rejects(operation, /PHYSICAL_DEADLINE/u);
            assert.equal(calls.includes('COMMIT'), false);
            assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'release']);
            if (expiresAfter === 'connect') assert.equal(calls.length, 2);
            if (expiresAfter === 'identity')
                assert.equal(
                    calls.some((sql) => sql.includes('vx_generations')),
                    false
                );
        } else {
            const proof = await operation;
            assert.equal(
                proof.generations[0].publicationId,
                manifest.publicationId
            );
            assert.deepEqual(calls.slice(-2), ['COMMIT', 'release']);
        }
    }
});

test('actual continuity checker admits the complete same-G1 same-task retry chain', () => {
    const phases = [
        'vector-g1-ready',
        'vector-g2-staged',
        'vector-outage-failed',
        'vector-restored-before-retry',
        'vector-g2-ready',
        'vector-signed-out',
    ];
    const epochs = [0, 0, 5, 5, 7, 7];
    let baseline = null,
        previous = null;
    for (let i = 0; i < phases.length; i++) {
        const current = continuityObservation(phases[i], epochs[i]);
        checkContinuity(current, baseline, previous);
        baseline ??= current;
        previous = current;
    }
});

test('coherently changed G1 application and physical publications or destinations cannot replace the ready baseline', () => {
    const baseline = continuityObservation('vector-g1-ready', 0);
    const staged = continuityObservation('vector-g2-staged', 0);
    const changedPublication = continuityObservation(
        'vector-restored-before-retry',
        5,
        (value) => {
            const candidate = value.candidates.find(
                (row) => row.generationId === g1
            );
            const old = candidate.id,
                replacement = old + '-replacement';
            candidate.id = replacement;
            const rows = value.chunks.filter(
                (row) => row.indexedDocumentId === old
            );
            const ids = new Map(
                rows.map((row) => [row.id, row.id + '-replacement'])
            );
            for (const row of rows) {
                row.indexedDocumentId = replacement;
                row.id = ids.get(row.id);
                if (row.parentId) row.parentId = ids.get(row.parentId);
            }
            value.holds.find(
                (row) => row.indexedDocumentId === old
            ).indexedDocumentId = replacement;
            value.desired.find(
                (row) => row.generationId === g1
            ).publishedIndexedDocumentId = replacement;
            value.tasks.find(
                (row) => row.indexedDocumentId === old
            ).indexedDocumentId = replacement;
            candidate.manifestHash = sha(
                JSON.stringify(
                    rows
                        .filter((row) => row.kind === 'CHILD')
                        .map((row) => [row.id, row.ordinal, row.textHash])
                )
            );
        }
    );
    assert.throws(
        () => checkContinuity(changedPublication, baseline, staged),
        /G1_MANIFEST_CONTINUITY/u
    );
    const changedDestination = continuityObservation(
        'vector-outage-failed',
        5,
        (value) => {
            for (const generation of value.generations)
                generation.destinationFingerprint = 'e'.repeat(64);
        }
    );
    assert.throws(
        () => checkContinuity(changedDestination, baseline, staged),
        /G1_MANIFEST_CONTINUITY/u
    );
    const changedPhysical = continuityObservation('vector-g2-staged', 0);
    changedPhysical.physical.generations[0].destinationFingerprint = 'e'.repeat(
        64
    );
    assert.throws(
        () => checkContinuity(changedPhysical, baseline, baseline),
        /G1_PHYSICAL_CONTINUITY/u
    );
});

test('retry must finish the exact failed task with a strictly advanced epoch, stable through final sign-out', () => {
    const baseline = continuityObservation('vector-g1-ready', 0);
    const failed = continuityObservation('vector-outage-failed', 5);
    const restored = continuityObservation('vector-restored-before-retry', 5);
    const complete = continuityObservation('vector-g2-ready', 7);
    for (const phase of [
        'vector-outage-failed',
        'vector-restored-before-retry',
        'vector-g2-ready',
        'vector-signed-out',
    ]) {
        const previous =
            phase === 'vector-outage-failed'
                ? continuityObservation('vector-g2-staged', 0)
                : phase === 'vector-restored-before-retry'
                  ? failed
                  : phase === 'vector-g2-ready'
                    ? restored
                    : complete;
        const epoch =
            phase === 'vector-outage-failed' ||
            phase === 'vector-restored-before-retry'
                ? 5
                : 7;
        const changed = continuityObservation(phase, epoch, (value) => {
            value.tasks.find(
                (row) => row.generationId === g2 && row.kind === 'PROVISION'
            ).id += '-replacement';
        });
        assert.throws(
            () => checkContinuity(changed, baseline, previous),
            /TASK_CONTINUITY/u
        );
    }
    assert.throws(
        () =>
            checkContinuity(
                continuityObservation('vector-restored-before-retry', 6),
                baseline,
                failed
            ),
        /TASK_EPOCH_CONTINUITY/u
    );
    assert.throws(
        () =>
            checkContinuity(
                continuityObservation('vector-g2-ready', 5),
                baseline,
                restored
            ),
        /TASK_EPOCH_CONTINUITY/u
    );
    assert.throws(
        () =>
            checkContinuity(
                continuityObservation('vector-signed-out', 8),
                baseline,
                complete
            ),
        /TASK_EPOCH_CONTINUITY/u
    );
});
