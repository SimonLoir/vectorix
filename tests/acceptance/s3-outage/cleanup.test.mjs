import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
    PROTOCOL_VERSION,
    scenarioSpec,
    sameScope,
    receiptScope,
    context,
} from './private.mjs';
import {
    executeCleanupFixture,
    requireDeleteBudget,
    STATIC_DRAFT_ONLY as fixtureDraft,
} from './cleanup-fixture.mjs';
import {
    assessCleanupSnapshot,
    validateCleanupTrace,
    readCleanupSnapshot,
    STATIC_DRAFT_ONLY as observerDraft,
} from './cleanup-observe.mjs';
import { assertObjectDescriptor, assertOnlineObjectPhase } from './objects.mjs';

const runId = '012345abcdef',
    bytes = Buffer.from('Synthetic cleanup fixture\n'),
    sha256 = createHash('sha256').update(bytes).digest('hex');
const state = {
    scenario: 'CLEANUP_V1',
    runId,
    protocolVersion: 2,
    processes: { workers: { pid: 123, startTicks: '42' } },
    resources: { rustfs: { id: 'a'.repeat(64) } },
};
const fixture = {
    ...receiptScope(state),
    namespace: 'vectorix-m7c-s3-cleanup',
    setup: { directWrites: 'NONE_NATIVE_HTTP_ONLY' },
    users: {
        owner: {
            userId: 'owner',
            email: 'owner@example.test',
            password: 'synthetic',
        },
    },
    organization: { id: 'org' },
    membershipSnapshot: [
        { id: 'member', organizationId: 'org', userId: 'owner', role: 'owner' },
    ],
};
const expected = { bytes: bytes.length, sha256, fileName: 's3-outage-v1.txt' };
const baseline = {
    ...receiptScope(state),
    phase: 'cleanup-ready',
    status: 'OBSERVED',
    faultEnrollmentAdmission: {
        kind: 'CLEANUP_READY_IDLE',
        organizationId: 'org',
        documentId: 'doc',
        versionId: 'v1',
    },
};
const ack = {
    ...receiptScope(state),
    worker: state.processes.workers,
    rustfs: state.resources.rustfs,
    budgetSeconds: 900,
    deadlineMonotonicNs: '900000000000',
};
const at = '2026-10-24T10:00:00.000Z';
const later = (ms) => new Date(Date.parse(at) + ms).toISOString();
const clone = (value) => structuredClone(value);
function snapshot(phase = 'cleanup-ready') {
    const ready = phase === 'cleanup-ready',
        complete = ['cleanup-complete', 'cleanup-signed-out'].includes(phase),
        signedOut = phase === 'cleanup-signed-out';
    const extraction = {
        id: 'extract',
        versionId: 'v1',
        organizationId: 'org',
        storageLocationId: 'location',
        objectKey: 'org/doc/v1/text.txt',
        byteSize: BigInt(bytes.length),
        extractorVersion: 'utf8-text-v1',
        language: 'und',
        discardedAt: complete ? later(400000) : null,
        createdAt: at,
    };
    const actions = [
        'document.upload.reserved',
        'document.upload.stored',
        'document.extraction.ready',
        ...(ready ? [] : ['document.deleted']),
        ...(complete
            ? ['document.cleanup.retried', 'document.cleanup.complete']
            : []),
    ];
    const staged = phase === 'cleanup-staged';
    return {
        observedAt: later(500000),
        counts: {
            users: 1,
            organizations: 1,
            members: 1,
            sessions: signedOut ? 0 : 1,
            documents: 1,
            versions: 1,
            extractions: 1,
            cleanups: ready ? 0 : 1,
            keys: 0,
            holds: 0,
            credentials: 0,
            generations: 0,
        },
        indexTasks: 0,
        user: {
            id: 'owner',
            isSuperAdmin: false,
            emailVerified: false,
            locale: 'fr',
        },
        organization: {
            id: 'org',
            isActive: true,
            slug: `m7c-s3-cleanup-${runId}-owner`,
        },
        members: clone(fixture.membershipSnapshot),
        sessions: signedOut
            ? []
            : [
                  {
                      id: 'session',
                      userId: 'owner',
                      activeOrganizationId: 'org',
                      expiresAt: later(1000000),
                  },
              ],
        documents: [
            {
                id: 'doc',
                organizationId: 'org',
                name: expected.fileName,
                status: ready ? 'READY' : 'DELETED',
                deletedAt: ready ? null : at,
            },
        ],
        locations: [
            {
                id: 'location',
                organizationId: 'org',
                credentialId: null,
                forcePathStyle: true,
            },
        ],
        versions: [
            {
                id: 'v1',
                documentId: 'doc',
                organizationId: 'org',
                version: 1,
                fileName: expected.fileName,
                mediaType: 'text/plain',
                sha256,
                byteSize: BigInt(bytes.length),
                storedAt: at,
                createdAt: at,
                storageLocationId: 'location',
                objectKey: 'org/doc/v1/original',
                status: ready ? 'READY' : 'DELETED',
                contentState: complete
                    ? 'PURGED'
                    : ready || staged
                      ? 'AVAILABLE'
                      : 'DELETING',
                discardedAt: complete ? later(400000) : null,
                extraction,
                tokenCount: 0,
                ingestion: {
                    versionId: 'v1',
                    organizationId: 'org',
                    requestedBy: 'owner',
                    status: ready ? 'READY' : 'FAILED',
                    errorCode: ready ? null : 'ACCESS_REVOKED',
                    attempts: 1,
                    reservedBytes: 0n,
                    leasedUntil: null,
                },
                cleanup: ready
                    ? null
                    : {
                          versionId: 'v1',
                          organizationId: 'org',
                          requestedBy: 'owner',
                          reason: 'DELETED',
                          status: complete
                              ? 'COMPLETE'
                              : staged
                                ? 'PENDING'
                                : 'FAILED',
                          scheduledAt: at,
                          availableAt: later(300000),
                          attempts: complete ? 1 : staged ? 0 : 5,
                          errorCode:
                              complete || staged ? null : 'STORAGE_UNAVAILABLE',
                          leasedUntil: null,
                          completedAt: complete ? later(400000) : null,
                          createdAt: at,
                          updatedAt: later(300000),
                      },
            },
        ],
        tokenCount: 0,
        cleanupTokenCount: 0,
        audits: actions.map((action) => ({
            organizationId: 'org',
            targetId: 'doc',
            action,
            details:
                action === 'document.deleted'
                    ? { retentionDays: 0, versions: 1 }
                    : { versionId: 'v1' },
        })),
        quota: {
            originalBytes: String(complete ? 0 : bytes.length),
            extractionBytes: String(complete ? 0 : bytes.length),
            reservedBytes: '0',
            storageBytes: String(complete ? 0 : bytes.length * 2),
        },
    };
}
function trace() {
    let failureAt = 0;
    return [1, 2, 3, 4, 5].map((attempts) => {
        const row = {
            observedAt: later(failureAt),
            updatedAt: later(failureAt),
            availableAt: later(failureAt + 10000 * 2 ** attempts),
            status: attempts === 5 ? 'FAILED' : 'PENDING',
            attempts,
            tokenCount: 0,
            leasedUntil: null,
            errorCode: 'STORAGE_UNAVAILABLE',
        };
        failureAt += 10000 * 2 ** attempts;
        return row;
    });
}

test('protocol and explicit closed scenarios reject legacy/cross-scenario before state I/O', () => {
    assert.equal(PROTOCOL_VERSION, 2);
    assert.equal(fixtureDraft, true);
    assert.equal(observerDraft, true);
    assert.equal(
        scenarioSpec('CLEANUP_V1').namespace,
        'vectorix-m7c-s3-cleanup'
    );
    for (const value of [undefined, '__proto__', 'cleanup'])
        assert.throws(() => scenarioSpec(value), /SCENARIO_REQUIRED/u);
    assert.equal(sameScope(state, { schemaVersion: 1, runId }), false);
    assert.equal(
        sameScope(state, { ...receiptScope(state), scenario: 'INGESTION_V1' }),
        false
    );
    assert.throws(() => context(['--run', runId], 'observe'), /ARGUMENTS/u);
});
test('DELETE budget is inclusive 625 seconds and never adopts a different original ACK', () => {
    requireDeleteBudget(state, ack, 275000000000n);
    assert.throws(
        () => requireDeleteBudget(state, ack, 275000000001n),
        /ORIGINAL_BUDGET/u
    );
    for (const change of [
        { protocolVersion: 1 },
        { scenario: 'INGESTION_V1' },
        { worker: { pid: 999 } },
        { deadlineMonotonicNs: 'Infinity' },
    ])
        assert.throws(() =>
            requireDeleteBudget(state, { ...ack, ...change }, 0n)
        );
});
test('native fixture performs one DELETE with exact expected version and always signs out', async () => {
    const operations = [];
    const request = async (operation, body, before) => {
        operations.push(operation);
        before?.();
        if (operation === 'SIGN_IN') return { user: { id: 'owner' } };
        if (operation === 'SESSION')
            return {
                user: { id: 'owner' },
                session: { activeOrganizationId: 'org' },
            };
        if (operation === 'DELETE')
            assert.deepEqual(body, {
                expectedVersionId: 'v1',
                retentionDays: 0,
            });
        return { success: true };
    };
    const result = await executeCleanupFixture({
        state,
        fixture,
        baseline,
        ack,
        request,
        nowNs: () => 0n,
    });
    assert.equal(result.acceptance, 'CONFIRMED_NATIVE_HTTP');
    assert.deepEqual(operations, [
        'SIGN_IN',
        'SET_ACTIVE',
        'SESSION',
        'DELETE',
        'SIGN_OUT',
    ]);
});
test('a late durable BEFORE or unknown DELETE never retries and still signs out', async () => {
    for (const late of [true, false]) {
        const operations = [];
        await assert.rejects(
            executeCleanupFixture({
                state,
                fixture,
                baseline,
                ack,
                nowNs: () => (late ? 275000000001n : 0n),
                request: async (operation, _body, before) => {
                    operations.push(operation);
                    before?.();
                    if (operation === 'SIGN_IN')
                        return { user: { id: 'owner' } };
                    if (operation === 'SESSION')
                        return {
                            user: { id: 'owner' },
                            session: { activeOrganizationId: 'org' },
                        };
                    if (operation === 'DELETE')
                        throw new Error('synthetic unknown');
                    return { success: true };
                },
            })
        );
        assert.equal(
            operations.filter((value) => value === 'DELETE').length,
            1
        );
        assert.equal(operations.at(-1), 'SIGN_OUT');
    }
});
test('wrong-session fixture refuses before DELETE and keeps cleanup signout', async () => {
    const operations = [];
    await assert.rejects(
        executeCleanupFixture({
            state,
            fixture,
            baseline,
            ack,
            request: async (operation) => {
                operations.push(operation);
                return operation === 'SIGN_IN'
                    ? { user: { id: 'foreign' } }
                    : { success: true };
            },
        }),
        /DELETE_USER/u
    );
    assert.deepEqual(operations, ['SIGN_IN', 'SIGN_OUT']);
});
test('cleanup states prove retained charge until final discard, with original source/schedule immutable', () => {
    let previous = null;
    for (const phase of [
        'cleanup-ready',
        'cleanup-staged',
        'cleanup-outage-failed',
        'cleanup-restored-before-retry',
        'cleanup-complete',
        'cleanup-signed-out',
    ]) {
        const result = assessCleanupSnapshot(
            snapshot(phase),
            phase,
            fixture,
            expected,
            previous
        );
        assert.equal(
            result.quota.storageBytes,
            String(result.purged ? 0 : bytes.length * 2)
        );
        previous = { ...receiptScope(state), ...result };
    }
});
test('busy/retained-hold/stale reservation/early discard/wrong binding cannot become a cleanup proof', () => {
    const mutations = [
        (s) => {
            s.versions[0].ingestion.leasedUntil = later(600000);
        },
        (s) => {
            s.counts.holds = 1;
        },
        (s) => {
            s.quota.reservedBytes = '1';
        },
        (s) => {
            s.versions[0].discardedAt = at;
        },
        (s) => {
            s.versions[0].objectKey = 'foreign/key';
        },
        (s) => {
            s.versions[0].cleanup.attempts = 4;
        },
        (s) => {
            s.cleanupTokenCount = 1;
        },
        (s) => {
            s.indexTasks = 1;
        },
        (s) => {
            s.audits.at(-1).details.retentionDays = 7;
        },
    ];
    for (const mutate of mutations) {
        const value = snapshot('cleanup-outage-failed');
        mutate(value);
        assert.throws(() =>
            assessCleanupSnapshot(
                value,
                'cleanup-outage-failed',
                fixture,
                expected
            )
        );
    }
    const complete = snapshot('cleanup-complete');
    complete.quota.storageBytes = String(bytes.length * 2);
    assert.throws(
        () =>
            assessCleanupSnapshot(
                complete,
                'cleanup-complete',
                fixture,
                expected
            ),
        /QUOTA/u
    );
});
test('cleanup trace requires every naturally elapsed backoff, fifth failure and null cleanup deadlines', () => {
    assert.deepEqual(
        validateCleanupTrace(trace()).observedBackoffMilliseconds,
        [20000, 40000, 80000, 160000]
    );
    for (const mutate of [
        (rows) => rows.splice(1, 1),
        (rows) => {
            rows[0].leasedUntil = rows[0].availableAt;
        },
        (rows) => {
            rows[2].observedAt = at;
        },
        (rows) => {
            rows[4].attempts = 4;
        },
        (rows) => {
            rows[3].availableAt = rows[3].updatedAt;
        },
    ]) {
        const rows = trace();
        mutate(rows);
        assert.throws(() => validateCleanupTrace(rows));
    }
});
test('purged absence keys remain scoped and both outage phases refuse S3 admission', () => {
    for (const phase of ['outage-failed', 'cleanup-outage-failed'])
        assert.throws(
            () => assertOnlineObjectPhase(phase),
            /ONLINE_ADMISSION/u
        );
    assertOnlineObjectPhase('cleanup-complete');
    const scopedState = {
            ...state,
            ports: { rustfs: 19000 },
            environment: {
                VECTORIX_DEFAULT_S3_BUCKET: 'bucket',
                VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
            },
        },
        bindings = [
            {
                documentId: 'doc',
                versionId: 'v1',
                version: 1,
                sha256,
                byteSize: bytes.length,
                purged: true,
            },
        ],
        descriptor = {
            organizationId: 'org',
            documentId: 'doc',
            versionId: 'v1',
            kind: 'structuredArtifact',
            key: 'org/doc/v1/extraction.json',
            byteSize: bytes.length,
            expectedSha256: sha256,
            location: {
                organizationId: 'org',
                credentialId: null,
                endpoint: 'http://127.0.0.1:19000',
                bucket: 'bucket',
                region: 'us-east-1',
                forcePathStyle: true,
            },
        };
    assert.equal(
        assertObjectDescriptor(descriptor, scopedState, fixture, bindings),
        descriptor.key
    );
    for (const change of [
        { key: 'org/doc/v1/other' },
        { versionId: 'foreign' },
        {
            location: {
                ...descriptor.location,
                credentialId: 'org-credential',
            },
        },
    ])
        assert.throws(() =>
            assertObjectDescriptor(
                { ...descriptor, ...change },
                scopedState,
                fixture,
                bindings
            )
        );
    assert.throws(() =>
        assertObjectDescriptor(descriptor, scopedState, fixture, [
            { ...bindings[0], purged: false },
        ])
    );
});

test('actual snapshot reader scopes all quota sums and projects only lease predicate counts', async () => {
    const value = snapshot(),
        projections = [],
        aggregates = [];
    const tx = new Proxy(
        {},
        {
            get(_target, name) {
                if (name === 'then') return undefined;
                const rows = {
                    member: value.members,
                    session: value.sessions,
                    document: value.documents,
                    documentVersion: value.versions,
                    storageLocation: value.locations,
                    ragAuditLog: value.audits,
                };
                return {
                    count: async () => 0,
                    findUnique: async () =>
                        name === 'user' ? value.user : value.organization,
                    findMany: async (query) => {
                        projections.push(query);
                        return clone(rows[name] ?? []);
                    },
                    aggregate: async (query) => {
                        aggregates.push({ name, query });
                        return {
                            _sum:
                                name === 'documentIngestion'
                                    ? { reservedBytes: 0n }
                                    : { byteSize: BigInt(bytes.length) },
                        };
                    },
                };
            },
        }
    );
    const result = await readCleanupSnapshot(tx, fixture);
    assert.deepEqual(result.quota, value.quota);
    assert.equal(aggregates.length, 3);
    assert.ok(
        aggregates.every(({ query }) => query.where.organizationId === 'org')
    );
    assert.equal(JSON.stringify(projections).includes('leaseToken'), false);
    assert.ok(projections.every((query) => query.take <= 9));
});
