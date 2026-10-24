import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
    STATIC_DRAFT_ONLY,
    completeReadOnlyObservation,
    requiresPhysicalObjects,
    REDIS_PHASE_MAP,
    validateFixtures,
    assessSnapshot,
    validateBackoffTrace,
    watchdogTraceDeadline,
    waitForNextSnapshot,
    readSnapshot,
} from './observe.mjs';

const metadata = JSON.parse(
    fs.readFileSync(
        new URL('./fixtures/expected.json', import.meta.url),
        'utf8'
    )
);
const originals = [1, 2].map((number) =>
    fs.readFileSync(
        new URL(`./fixtures/s3-outage-v${number}.txt`, import.meta.url)
    )
);
const expected = metadata.versions;
const created = '2026-10-24T12:00:00.000Z',
    at = '2026-10-24T12:10:00.000Z';
const fixture = {
    schemaVersion: 1,
    protocolVersion: 2,
    scenario: 'INGESTION_V1',
    namespace: 'vectorix-m7c-s3-outage',
    runId: '123456abcdef',
    setup: { directWrites: 'NONE_NATIVE_HTTP_ONLY' },
    users: { owner: { userId: 'owner' } },
    organization: { id: 'org' },
    membershipSnapshot: [
        {
            id: 'member',
            organizationId: 'org',
            userId: 'owner',
            role: 'owner',
            createdAt: created,
        },
    ],
};
const clone = (value) => structuredClone(value);
function nativeAudit(action, versionId, extra = {}) {
    return {
        organizationId: 'org',
        action,
        targetId: 'document',
        details: { versionId, ...extra },
    };
}
function version(number, published) {
    const wanted = expected[number - 1];
    return {
        id: `version${number}`,
        organizationId: 'org',
        documentId: 'document',
        version: number,
        storageLocationId: 'location',
        objectKey: `org/document/version${number}/original`,
        sha256: wanted.sha256,
        byteSize: BigInt(wanted.bytes),
        fileName: wanted.fileName,
        mediaType: 'text/plain',
        status: published ? 'READY' : 'PROCESSING',
        contentState: 'AVAILABLE',
        storedAt: created,
        discardedAt: null,
        createdAt: created,
        tokenCount: 0,
        ingestion: {
            versionId: `version${number}`,
            organizationId: 'org',
            requestedBy: 'owner',
            status: published ? 'READY' : 'PENDING',
            reservedBytes: published ? 0n : BigInt(wanted.bytes),
            attempts: published ? 1 : 0,
            errorCode: null,
            leasedUntil: null,
            availableAt: created,
            createdAt: created,
            updatedAt: created,
        },
        extraction: published
            ? {
                  id: `extraction${number}`,
                  organizationId: 'org',
                  versionId: `version${number}`,
                  storageLocationId: 'location',
                  objectKey: `org/document/version${number}/text.txt`,
                  byteSize: BigInt(wanted.bytes),
                  extractorVersion: 'utf8-text-v1',
                  language: 'und',
                  discardedAt: null,
                  createdAt: created,
              }
            : null,
        cleanup: null,
    };
}
function snapshot(phase) {
    const baseline = phase === 'v1-ready',
        ready = ['v2-ready', 'signed-out'].includes(phase);
    const versions = baseline
        ? [version(1, true)]
        : [version(1, true), version(2, ready)];
    if (!baseline)
        versions[0].cleanup = {
            versionId: 'version1',
            organizationId: 'org',
            requestedBy: 'owner',
            reason: 'REPLACED',
            status: 'PENDING',
            scheduledAt: '2026-10-31T12:00:00.000Z',
            availableAt: '2026-10-31T12:00:00.000Z',
            attempts: 0,
            errorCode: null,
            leasedUntil: null,
            completedAt: null,
            createdAt: created,
            updatedAt: created,
        };
    if (['outage-failed', 'restored-before-retry'].includes(phase)) {
        versions[1].status = 'FAILED';
        Object.assign(versions[1].ingestion, {
            status: 'FAILED',
            attempts: 5,
            errorCode: 'STORAGE_UNAVAILABLE',
            availableAt: '2026-10-24T12:15:00.000Z',
        });
    }
    const counts = Object.fromEntries(
        [
            'users',
            'organizations',
            'members',
            'sessions',
            'collections',
            'keys',
            'groups',
            'invitations',
            'credentials',
            's3Credentials',
            'selections',
            'superAdminAudits',
            'push',
            'preferences',
            'generations',
            'holds',
            'chunks',
            'quotaOverrides',
            'documents',
            'versions',
            'extractions',
            'cleanups',
        ].map((key) => [key, 0])
    );
    Object.assign(counts, {
        users: 1,
        organizations: 1,
        members: 1,
        sessions: phase === 'signed-out' ? 0 : 1,
        documents: 1,
        versions: versions.length,
        extractions: ready ? 2 : 1,
        cleanups: baseline ? 0 : 1,
    });
    const audits = [
        nativeAudit('document.upload.reserved', 'version1'),
        nativeAudit('document.upload.stored', 'version1'),
        nativeAudit('document.extraction.ready', 'version1'),
    ];
    if (!baseline)
        audits.push(
            nativeAudit('document.replacement.reserved', 'version2', {
                previousVersionId: 'version1',
                retentionDays: 7,
            }),
            nativeAudit('document.upload.stored', 'version2')
        );
    if (ready)
        audits.push(
            nativeAudit('document.extraction.retried', 'version2'),
            nativeAudit('document.extraction.ready', 'version2')
        );
    return {
        observedAt: at,
        counts,
        user: {
            id: 'owner',
            locale: 'en',
            isSuperAdmin: false,
            emailVerified: false,
        },
        organization: {
            id: 'org',
            slug: 'm7c-s3-outage-123456abcdef-owner',
            isActive: true,
        },
        members: clone(fixture.membershipSnapshot),
        sessions:
            phase === 'signed-out'
                ? []
                : [
                      {
                          id: 'session',
                          userId: 'owner',
                          activeOrganizationId: 'org',
                          expiresAt: '2030-01-01T00:00:00.000Z',
                      },
                  ],
        documents: [
            {
                id: 'document',
                organizationId: 'org',
                name: expected[ready ? 1 : 0].fileName,
                status: 'READY',
                deletedAt: null,
                createdAt: created,
            },
        ],
        locations: [
            {
                id: 'location',
                organizationId: 'org',
                credentialId: null,
                endpoint: 'http://127.0.0.1:19000',
                bucket: 'test',
                region: 'us-east-1',
                forcePathStyle: true,
            },
        ],
        versions,
        tokenCount: 0,
        cleanupTokenCount: 0,
        audits,
    };
}
function previous(snapshotValue, phase, prior = null) {
    return {
        runId: fixture.runId,
        snapshot: snapshotValue,
        ...assessSnapshot(snapshotValue, phase, fixture, expected, prior),
    };
}
function trace() {
    let now = Date.parse(created);
    return Array.from({ length: 5 }, (_, index) => {
        const attempts = index + 1,
            availableAt = new Date(now + 10000 * 2 ** attempts).toISOString();
        const result = {
            observedAt: new Date(now + 100).toISOString(),
            status: attempts === 5 ? 'FAILED' : 'PENDING',
            attempts,
            errorCode: 'STORAGE_UNAVAILABLE',
            tokenCount: 0,
            availableAt,
            leasedUntil: attempts === 5 ? null : availableAt,
            updatedAt: new Date(now).toISOString(),
        };
        now = Date.parse(availableAt) + 1000;
        return result;
    });
}

void test('observer remains disabled and the two real fixture bytes match distinct canonical metadata', () => {
    assert.equal(STATIC_DRAFT_ONLY, true);
    assert.equal(validateFixtures(metadata, originals), metadata.versions);
    assert.equal(expected[0].bytes, 522);
    assert.equal(expected[1].bytes, 620);
    assert.equal(expected[0].utf16Characters, 512);
    assert.equal(expected[1].utf16Characters, 609);
    const changed = clone(metadata);
    changed.versions[1].canonicalSha256 = expected[0].sha256;
    assert.throws(
        () => validateFixtures(changed, originals),
        /S3_OUTAGE_FIXTURE_CANONICAL/u
    );
    assert.throws(
        () =>
            validateFixtures(metadata, [
                originals[0],
                Buffer.concat([originals[1], Buffer.from('\r')]),
            ]),
        /S3_OUTAGE_FIXTURE_CANONICAL/u
    );
});
void test('the actual staged→failed→same-version retry shapes preserve serving v1 and replace reserved bytes with extraction', () => {
    const first = previous(snapshot('v1-ready'), 'v1-ready');
    const staged = previous(snapshot('v2-staged'), 'v2-staged', first);
    const failed = previous(snapshot('outage-failed'), 'outage-failed', staged);
    const restored = previous(
        snapshot('restored-before-retry'),
        'restored-before-retry',
        failed
    );
    const ready = previous(snapshot('v2-ready'), 'v2-ready', restored);
    assert.equal(first.servingVersion, 1);
    assert.equal(failed.servingVersion, 1);
    assert.equal(ready.servingVersion, 2);
    assert.equal(failed.quota.storageBytes, 2284);
    assert.equal(ready.quota.storageBytes, 2284);
    assert.equal(failed.quota.reservedBytes, 620);
    assert.equal(ready.quota.reservedBytes, 0);
    assert.equal(failed.operations.failedIngestion, 1);
    assert.equal(ready.operations.currentIngestion, 0);
    assert.equal(failed.operations.scheduledCleanup, 1);
    const signedOut = assessSnapshot(
        snapshot('signed-out'),
        'signed-out',
        fixture,
        expected,
        ready
    );
    assert.equal(signedOut.servingVersion, 2);
});
void test('future retry backoff is scheduled, not a live claim, and terminal fifth failure may retain future availableAt', () => {
    const value = snapshot('v2-staged'),
        task = value.versions[1].ingestion;
    Object.assign(task, {
        attempts: 1,
        errorCode: 'STORAGE_UNAVAILABLE',
        availableAt: '2026-10-24T12:11:00.000Z',
        leasedUntil: '2026-10-24T12:11:00.000Z',
    });
    const assessed = assessSnapshot(
        value,
        'outage-progress',
        fixture,
        expected
    );
    assert.equal(assessed.operations.latestIngestionState, 'SCHEDULED');
    assert.equal(assessed.operations.liveClaim, false);
    assert.equal(assessed.operations.tokenCount, 0);
    assert.equal(
        assessSnapshot(
            snapshot('outage-failed'),
            'outage-failed',
            fixture,
            expected
        ).operations.failedIngestion,
        1
    );
});
void test('wrong owner, foreign version, publication drift, extra content, token and premature retention are refused', () => {
    const mutations = [
        (value) => (value.members[0].role = 'admin'),
        (value) => (value.versions[1].organizationId = 'foreign'),
        (value) => (value.versions[0].status = 'FAILED'),
        (value) => (value.counts.collections = 1),
        (value) => (value.cleanupTokenCount = 1),
        (value) => (value.versions[0].cleanup.scheduledAt = at),
        (value) => (value.versions[1].ingestion.reservedBytes = 0n),
        (value) =>
            (value.audits.find(
                (row) => row.action === 'document.replacement.reserved'
            ).details.retentionDays = 0),
    ];
    for (const mutate of mutations) {
        const value = snapshot('outage-failed');
        mutate(value);
        assert.throws(
            () => assessSnapshot(value, 'outage-failed', fixture, expected),
            /S3_OUTAGE_/u
        );
    }
});
void test('immutable source and accepted seven-day cleanup cannot be rewritten between phases', () => {
    const staged = previous(snapshot('v2-staged'), 'v2-staged');
    for (const mutate of [
        (value) => (value.versions[0].storedAt = '2026-10-24T11:59:59.000Z'),
        (value) => (value.versions[1].storedAt = '2026-10-24T11:59:59.000Z'),
        (value) =>
            (value.versions[0].cleanup.availableAt =
                '2026-10-31T12:00:01.000Z'),
        (value) => (value.sessions[0].id = 'other-session'),
    ]) {
        const value = snapshot('outage-failed');
        mutate(value);
        assert.throws(
            () =>
                assessSnapshot(
                    value,
                    'outage-failed',
                    fixture,
                    expected,
                    staged
                ),
            /S3_OUTAGE_/u
        );
    }
    const ready = snapshot('v2-ready');
    ready.audits.find(
        (row) =>
            row.action === 'document.extraction.ready' &&
            row.details.versionId === 'version2'
    ).details.versionId = 'version1';
    assert.throws(
        () => assessSnapshot(ready, 'v2-ready', fixture, expected),
        /AUDIT_VERSION/u
    );
});
void test('all four natural backoffs are required; shortened/missing/early/claimed failures do not become a complete trace', () => {
    assert.equal(validateBackoffTrace(trace()).attempts, 5);
    const missing = trace();
    missing.splice(2, 1);
    assert.throws(
        () => validateBackoffTrace(missing),
        /SEQUENCE|MISSING_FAILURE/u
    );
    const shortened = trace();
    shortened[0].availableAt = shortened[0].updatedAt;
    shortened[0].leasedUntil = shortened[0].updatedAt;
    assert.throws(() => validateBackoffTrace(shortened), /BACKOFF/u);
    const early = trace();
    early[2].observedAt = new Date(
        Date.parse(early[1].availableAt) - 1
    ).toISOString();
    assert.throws(() => validateBackoffTrace(early), /EARLY_CLAIM/u);
    const claimed = trace();
    claimed[1].tokenCount = 1;
    assert.throws(
        () => validateBackoffTrace(claimed),
        /SEQUENCE|MISSING_FAILURE/u
    );
    const terminal = trace();
    terminal[4].leasedUntil = terminal[4].availableAt;
    assert.throws(() => validateBackoffTrace(terminal), /TERMINAL_LEASE/u);
});
void test('the original Python UTC-offset watchdog ACK supplies a finite shared deadline without timezone invention or refresh', () => {
    const wallNow = Date.parse(created),
        clock = { monotonicNs: 1000000000n, wallNow, performanceNow: 500 };
    const ack = {
        runId: fixture.runId,
        budgetSeconds: 900,
        deadlineMonotonicNs: String(1000000000n + 800000000000n),
        deadlineAt: '2026-10-24T12:13:20.000000+00:00',
    };
    assert.equal(watchdogTraceDeadline(ack, fixture.runId, clock), 720500);
    assert.equal(
        watchdogTraceDeadline(ack, fixture.runId, {
            ...clock,
            monotonicNs: 1000000000n + 700000000000n,
            wallNow: wallNow + 700000,
        }),
        100500
    );
    for (const deadlineAt of [
        '2026-10-24T12:13:20',
        '2026-10-24T12:13:20+01:00',
        'invalid',
    ])
        assert.throws(
            () =>
                watchdogTraceDeadline(
                    { ...ack, deadlineAt },
                    fixture.runId,
                    clock
                ),
            /WATCHDOG_BUDGET/u
        );
    assert.throws(
        () =>
            watchdogTraceDeadline(ack, fixture.runId, {
                ...clock,
                monotonicNs: 1000000000n + 800000000000n,
            }),
        /WATCHDOG_BUDGET/u
    );
});
void test('two-second snapshot pacing tolerates fractional early and equal wakeups while preserving a finite deadline', async () => {
    let clock = 0;
    const wakes = [1999.4, 1999.4, 2000],
        delays = [];
    await waitForNextSnapshot(2000, 3000, {
        now: () => clock,
        sleep: async (delay) => {
            delays.push(delay);
            clock = wakes.shift();
        },
    });
    assert.deepEqual(delays, [2000, 1, 1]);
    await assert.rejects(
        waitForNextSnapshot(2000, 1900, {
            now: () => 0,
            sleep: async () => {},
        }),
        /INCOMPLETE/u
    );
    let count = 0;
    await assert.rejects(
        waitForNextSnapshot(2000, 3000, {
            now: () => 0,
            sleep: async () => {
                count++;
            },
        }),
        /INCOMPLETE/u
    );
    assert.equal(count, 64);
});
void test('actual query builder projects no raw lease token and requires predicate counts instead', async () => {
    const value = snapshot('v1-ready'),
        selections = [],
        predicates = [];
    const tx = {};
    const counts = {
        user: 'users',
        organization: 'organizations',
        member: 'members',
        session: 'sessions',
        collection: 'collections',
        apikey: 'keys',
        organizationGroup: 'groups',
        invitation: 'invitations',
        credentials: 'credentials',
        s3Credentials: 's3Credentials',
        credentialSelection: 'selections',
        superAdminAuditLog: 'superAdminAudits',
        vectorixPushSubscription: 'push',
        vectorixNotificationPreference: 'preferences',
        indexGeneration: 'generations',
        documentSourceHold: 'holds',
        chunk: 'chunks',
        organizationQuota: 'quotaOverrides',
        document: 'documents',
        documentVersion: 'versions',
        documentExtraction: 'extractions',
        documentCleanup: 'cleanups',
    };
    for (const [model, key] of Object.entries(counts))
        tx[model] = {
            count: async (input) => {
                if (input) {
                    predicates.push(input);
                    return 0;
                }
                return value.counts[key];
            },
        };
    for (const [model, key] of [
        ['member', 'members'],
        ['session', 'sessions'],
        ['document', 'documents'],
        ['documentVersion', 'versions'],
        ['storageLocation', 'locations'],
        ['ragAuditLog', 'audits'],
    ])
        tx[model] = {
            ...tx[model],
            findMany: async (input) => {
                selections.push(input);
                return clone(value[key]);
            },
        };
    tx.user.findUnique = async () => clone(value.user);
    tx.organization.findUnique = async () => clone(value.organization);
    tx.documentIngestion = {
        count: async (input) => {
            predicates.push(input);
            return 0;
        },
    };
    const result = await readSnapshot(tx, fixture);
    assert.equal(result.tokenCount, 0);
    assert.equal(result.cleanupTokenCount, 0);
    assert.equal(JSON.stringify(selections).includes('leaseToken'), false);
    assert.equal(
        predicates.filter((input) => input.where.leaseToken?.not === null)
            .length,
        3
    );
});

function addReadKey(snapshot, fixture) {
    const audit = {
        id: 'key-audit',
        action: 'apiKey.create',
        organizationId: fixture.organization.id,
        actorType: 'user',
        actorId: fixture.users.owner.userId,
        targetId: 'read-key',
        details: { collectionCount: 0 },
    };
    snapshot.counts.keys = 1;
    snapshot.audits.push(audit);
    snapshot.readKey = {
        keys: [
            {
                id: 'read-key',
                name: `Redis read ${fixture.runId}`,
                configId: 'org',
                referenceId: fixture.organization.id,
                enabled: true,
                vectorixLegacyFullAccess: false,
                expiresAt: null,
                permissions: JSON.stringify({ ragLibrary: ['read'] }),
            },
        ],
        principals: [
            {
                keyId: 'read-key',
                organizationId: fixture.organization.id,
                memberId: fixture.membershipSnapshot[0].id,
            },
        ],
        scopes: 0,
    };
    fixture.readKey = {
        id: 'read-key',
        name: `Redis read ${fixture.runId}`,
        organizationId: fixture.organization.id,
        issuerUserId: fixture.users.owner.userId,
        memberId: fixture.membershipSnapshot[0].id,
        permissions: { ragLibrary: ['read'] },
        collectionScopes: [],
        auditId: audit.id,
    };
}

void test('Redis recovery keeps stored v2 pending with v1 readable, then publishes without a retry audit', () => {
    const redisFixture = {
        ...clone(fixture),
        scenario: 'REDIS_V1',
        namespace: 'vectorix-m7c-redis-outage',
    };
    const staged = snapshot('v2-staged');
    addReadKey(staged, redisFixture);
    staged.organization.slug = `m7c-redis-outage-${fixture.runId}-owner`;
    const pending = assessSnapshot(staged, 'v2-staged', redisFixture, expected);
    assert.equal(pending.servingVersion, 1);
    assert.equal(pending.quota.reservedBytes, expected[1].bytes);
    assert.equal(pending.operations.liveClaim, false);
    const ready = snapshot('v2-ready');
    addReadKey(ready, redisFixture);
    ready.organization.slug = staged.organization.slug;
    ready.audits = ready.audits.filter(
        (row) => row.action !== 'document.extraction.retried'
    );
    const recovered = assessSnapshot(ready, 'v2-ready', redisFixture, expected);
    assert.equal(recovered.servingVersion, 2);
    assert.equal(recovered.quota.reservedBytes, 0);
    assert.equal(
        recovered.quota.storageBytes,
        2 * (expected[0].bytes + expected[1].bytes)
    );
    ready.audits.push(nativeAudit('document.extraction.retried', 'version2'));
    assert.throws(
        () => assessSnapshot(ready, 'v2-ready', redisFixture, expected),
        /AUDIT/
    );
});

void test('Redis source policy never borrows another scenario namespace or accepts an already claimed pending version', () => {
    const redisFixture = {
        ...clone(fixture),
        scenario: 'REDIS_V1',
        namespace: 'vectorix-m7c-redis-outage',
    };
    const pending = snapshot('v2-staged');
    addReadKey(pending, redisFixture);
    pending.organization.slug = `m7c-redis-outage-${fixture.runId}-owner`;
    assert.doesNotThrow(() =>
        assessSnapshot(pending, 'v2-staged', redisFixture, expected)
    );
    assert.throws(
        () =>
            assessSnapshot(
                pending,
                'v2-staged',
                { ...redisFixture, namespace: fixture.namespace },
                expected
            ),
        /FIXTURE/
    );
    pending.versions[1].ingestion.attempts = 1;
    assert.throws(
        () => assessSnapshot(pending, 'v2-staged', redisFixture, expected),
        /STAGED_ORIGINAL/
    );
});

test('success publication follows successful disconnect and the final guard; either failure preserves absence', async () => {
    const order = [];
    await completeReadOnlyObservation({
        close: async () => {
            order.push('closed');
        },
        admit: () => {
            order.push('guarded');
        },
        publish: () => {
            order.push('published');
        },
    });
    assert.deepEqual(order, ['closed', 'guarded', 'published']);
    for (const failure of ['close', 'guard']) {
        const seen = [];
        await assert.rejects(
            completeReadOnlyObservation({
                close: async () => {
                    seen.push('close');
                    if (failure === 'close')
                        throw new Error('FIXED_CLOSE_REFUSAL');
                },
                admit: () => {
                    seen.push('guard');
                    throw new Error('FIXED_GUARD_REFUSAL');
                },
                publish: () => {
                    seen.push('published');
                },
            }),
            /FIXED_(?:CLOSE|GUARD)_REFUSAL/u
        );
        assert.deepEqual(
            seen,
            failure === 'close' ? ['close'] : ['close', 'guard']
        );
    }
});

test('Redis pre-cut staged proof is separate and the actual outage phase never selects physical I/O', () => {
    assert.deepEqual(Object.keys(REDIS_PHASE_MAP), [
        'redis-ready',
        'redis-staged',
        'redis-pending',
        'redis-recovered',
        'redis-signed-out',
    ]);
    assert.equal(
        requiresPhysicalObjects(REDIS_PHASE_MAP['redis-staged'], false),
        true
    );
    assert.equal(
        requiresPhysicalObjects(REDIS_PHASE_MAP['redis-pending'], true),
        false
    );
    assert.equal(requiresPhysicalObjects('outage-failed', false), false);
    assert.equal(
        requiresPhysicalObjects(REDIS_PHASE_MAP['redis-recovered'], false),
        true
    );
});
