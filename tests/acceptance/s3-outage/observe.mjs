/** Bounded isolated read-only evidence; outage tracing never creates or resolves an S3 client. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    HERE,
    receiptScope,
    sameScope,
    context,
    need,
    privateBytes,
    privateJson,
    writePrivate,
    openFixturePrisma,
    entryError,
} from './private.mjs';
import { createReadOnlyObjectObserver } from './objects.mjs';

export const STATIC_DRAFT_ONLY = true;
export const PHASES = Object.freeze([
    'v1-ready',
    'v2-staged',
    'outage-failed',
    'restored-before-retry',
    'v2-ready',
    'signed-out',
]);
export const TRACE_LIMITS = Object.freeze({
    milliseconds: 720000,
    snapshots: 360,
    changes: 11,
    intervalMs: 2000,
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) =>
    JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? item.toString() : item
    );
const same = (left, right) => canonical(left) === canonical(right);
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const hash = (value) =>
    typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const instant = (value) =>
    value instanceof Date
        ? value.getTime()
        : typeof value === 'string' && /(?:Z|\+00:00)$/u.test(value)
          ? Date.parse(value)
          : NaN;
const stringifySafe = (value) => JSON.parse(canonical(value));
const sourceActions = [
    'document.upload.reserved',
    'document.upload.stored',
    'document.extraction.ready',
    'document.replacement.reserved',
    'document.extraction.retried',
];
const countModels = Object.freeze({
    users: 'user',
    organizations: 'organization',
    members: 'member',
    sessions: 'session',
    collections: 'collection',
    keys: 'apikey',
    groups: 'organizationGroup',
    invitations: 'invitation',
    credentials: 'credentials',
    s3Credentials: 's3Credentials',
    selections: 'credentialSelection',
    superAdminAudits: 'superAdminAuditLog',
    push: 'vectorixPushSubscription',
    preferences: 'vectorixNotificationPreference',
    generations: 'indexGeneration',
    holds: 'documentSourceHold',
    chunks: 'chunk',
    quotaOverrides: 'organizationQuota',
    documents: 'document',
    versions: 'documentVersion',
    extractions: 'documentExtraction',
    cleanups: 'documentCleanup',
});

function publicBytes(name, state) {
    need(
        ['s3-outage-v1.txt', 's3-outage-v2.txt', 'expected.json'].includes(
            name
        ),
        'S3_OUTAGE_FIXTURE_NAME'
    );
    const file = path.join(HERE, 'fixtures', name),
        descriptor = fs.openSync(
            file,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        );
    try {
        const info = fs.fstatSync(descriptor);
        need(
            info.isFile() &&
                info.uid === process.getuid() &&
                (info.mode & 0o002) === 0 &&
                info.size > 0 &&
                info.size <= 16384,
            'S3_OUTAGE_FIXTURE_FILE'
        );
        const bytes = fs.readFileSync(descriptor),
            pin = state.inputs.textFixtures[name];
        need(
            bytes.length === info.size &&
                pin?.bytes === bytes.length &&
                pin.sha256 === sha(bytes),
            'S3_OUTAGE_FIXTURE_PIN'
        );
        return bytes;
    } finally {
        fs.closeSync(descriptor);
    }
}

/** Validate the exact two originals and their unchanged plain-text canonical representation. */
export function validateFixtures(metadata, originals) {
    need(
        metadata?.schemaVersion === 1 &&
            metadata.format === 'UTF8_TEXT' &&
            metadata.versions?.length === 2,
        'S3_OUTAGE_FIXTURE_METADATA'
    );
    for (const [index, row] of metadata.versions.entries()) {
        const bytes = originals[index],
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        need(
            row.version === index + 1 &&
                row.fileName === `s3-outage-v${index + 1}.txt` &&
                bytes instanceof Uint8Array &&
                bytes.length > 0 &&
                bytes.length <= 16384 &&
                !bytes.includes(13) &&
                !bytes.includes(0) &&
                !Buffer.from(bytes)
                    .subarray(0, 3)
                    .equals(Buffer.from([239, 187, 191])) &&
                row.bytes === bytes.length &&
                row.sha256 === sha(bytes) &&
                row.canonicalBytes === bytes.length &&
                row.canonicalSha256 === sha(bytes) &&
                row.utf16Characters === text.length &&
                row.extractorVersion === 'utf8-text-v1',
            'S3_OUTAGE_FIXTURE_CANONICAL'
        );
    }
    need(
        metadata.versions[0].sha256 !== metadata.versions[1].sha256 &&
            metadata.versions[0].bytes !== metadata.versions[1].bytes,
        'S3_OUTAGE_FIXTURES_DISTINCT'
    );
    return metadata.versions;
}

/** Fixed counts and at most two versions; token values are never selected, only predicate counts. */
export async function readSnapshot(tx, fixture) {
    const counts = Object.fromEntries(
        await Promise.all(
            Object.entries(countModels).map(async ([name, model]) => [
                name,
                await tx[model].count(),
            ])
        )
    );
    const user = await tx.user.findUnique({
        where: { id: fixture.users.owner.userId },
        select: {
            id: true,
            locale: true,
            isSuperAdmin: true,
            emailVerified: true,
        },
    });
    const organization = await tx.organization.findUnique({
        where: { id: fixture.organization.id },
        select: { id: true, slug: true, isActive: true },
    });
    const members = await tx.member.findMany({
        take: 2,
        orderBy: { id: 'asc' },
        select: {
            id: true,
            organizationId: true,
            userId: true,
            role: true,
            createdAt: true,
        },
    });
    const sessions = await tx.session.findMany({
        take: 2,
        orderBy: { id: 'asc' },
        select: {
            id: true,
            userId: true,
            activeOrganizationId: true,
            expiresAt: true,
        },
    });
    const documents = await tx.document.findMany({
        take: 2,
        orderBy: { id: 'asc' },
        select: {
            id: true,
            organizationId: true,
            name: true,
            status: true,
            deletedAt: true,
            createdAt: true,
        },
    });
    const locations = await tx.storageLocation.findMany({
        take: 2,
        orderBy: { id: 'asc' },
        select: {
            id: true,
            organizationId: true,
            credentialId: true,
            endpoint: true,
            bucket: true,
            region: true,
            forcePathStyle: true,
        },
    });
    const versions = await tx.documentVersion.findMany({
        take: 3,
        orderBy: { version: 'asc' },
        select: {
            id: true,
            organizationId: true,
            documentId: true,
            version: true,
            storageLocationId: true,
            objectKey: true,
            sha256: true,
            byteSize: true,
            fileName: true,
            mediaType: true,
            status: true,
            contentState: true,
            storedAt: true,
            discardedAt: true,
            createdAt: true,
            ingestion: {
                select: {
                    versionId: true,
                    organizationId: true,
                    requestedBy: true,
                    status: true,
                    reservedBytes: true,
                    attempts: true,
                    errorCode: true,
                    leasedUntil: true,
                    availableAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            },
            extraction: {
                select: {
                    id: true,
                    organizationId: true,
                    versionId: true,
                    storageLocationId: true,
                    objectKey: true,
                    byteSize: true,
                    extractorVersion: true,
                    language: true,
                    discardedAt: true,
                    createdAt: true,
                },
            },
            cleanup: {
                select: {
                    versionId: true,
                    organizationId: true,
                    requestedBy: true,
                    reason: true,
                    status: true,
                    scheduledAt: true,
                    availableAt: true,
                    attempts: true,
                    errorCode: true,
                    leasedUntil: true,
                    completedAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            },
        },
    });
    for (const version of versions)
        version.tokenCount = await tx.documentIngestion.count({
            where: { versionId: version.id, leaseToken: { not: null } },
        });
    const tokenCount = await tx.documentIngestion.count({
        where: { leaseToken: { not: null } },
    });
    const cleanupTokenCount = await tx.documentCleanup.count({
        where: { leaseToken: { not: null } },
    });
    const audits = await tx.ragAuditLog.findMany({
        take: 9,
        orderBy: { id: 'asc' },
        select: {
            organizationId: true,
            action: true,
            targetId: true,
            details: true,
        },
    });
    return {
        observedAt: new Date().toISOString(),
        counts,
        user,
        organization,
        members,
        sessions,
        documents,
        locations,
        versions,
        tokenCount,
        cleanupTokenCount,
        audits,
    };
}

function immutableVersion(version) {
    const { status, ingestion, cleanup, tokenCount, ...rest } = version;
    return rest;
}
function originalBinding(version) {
    const { status, ingestion, cleanup, tokenCount, extraction, ...rest } =
        version;
    return rest;
}
function taskState(task, at, tokenCount) {
    if (task.status === 'FAILED') return 'FAILED';
    if (task.status === 'PENDING')
        return instant(task.availableAt) > at ? 'SCHEDULED' : 'DUE';
    if (task.status === 'UPLOADING') return 'UPLOADING';
    return tokenCount === 1 && instant(task.leasedUntil) > at
        ? 'LEASED'
        : 'EXPIRED';
}

/** Assess authoritative catalog state only; an unavailable original is never described as readable. */
export function assessSnapshot(
    snapshot,
    phase,
    fixture,
    expected,
    previous = null
) {
    const progress = phase === 'outage-progress',
        baseline = phase === 'v1-ready',
        ready = ['v2-ready', 'signed-out'].includes(phase);
    const failed = ['outage-failed', 'restored-before-retry'].includes(phase),
        count = baseline ? 1 : 2,
        at = instant(snapshot.observedAt);
    need(PHASES.includes(phase) || progress, 'S3_OUTAGE_OBSERVER_PHASE');
    need(
        Number.isFinite(at) &&
            fixture.namespace === 'vectorix-m7c-s3-outage' &&
            /^[a-f\d]{12}$/u.test(fixture.runId) &&
            fixture.setup?.directWrites === 'NONE_NATIVE_HTTP_ONLY' &&
            fixture.users?.owner &&
            fixture.organization,
        'S3_OUTAGE_OBSERVER_FIXTURE'
    );
    const required = {
        users: 1,
        organizations: 1,
        members: 1,
        sessions: phase === 'signed-out' ? 0 : 1,
        documents: 1,
        versions: count,
        extractions: ready ? 2 : 1,
        cleanups: baseline ? 0 : 1,
    };
    for (const name of Object.keys(countModels))
        need(
            snapshot.counts[name] === (required[name] ?? 0),
            'S3_OUTAGE_OBSERVER_COUNTS'
        );
    const user = snapshot.user,
        organization = snapshot.organization;
    need(
        user?.id === fixture.users.owner.userId &&
            id(user.id) &&
            user.isSuperAdmin === false &&
            user.emailVerified === false &&
            ['en', 'fr', 'nl-BE'].includes(user.locale) &&
            organization?.id === fixture.organization.id &&
            organization.isActive === true &&
            organization.slug === `m7c-s3-outage-${fixture.runId}-owner` &&
            same(snapshot.members, fixture.membershipSnapshot) &&
            snapshot.members.length === 1 &&
            snapshot.members[0].role === 'owner' &&
            snapshot.members[0].userId === user.id &&
            snapshot.members[0].organizationId === organization.id,
        'S3_OUTAGE_OBSERVER_IDENTITY'
    );
    need(
        snapshot.sessions.length === (phase === 'signed-out' ? 0 : 1) &&
            snapshot.sessions.every(
                (row) =>
                    id(row.id) &&
                    row.userId === user.id &&
                    row.activeOrganizationId === organization.id &&
                    instant(row.expiresAt) > at
            ),
        'S3_OUTAGE_OBSERVER_SESSION'
    );
    need(
        snapshot.documents.length === 1 &&
            snapshot.locations.length === 1 &&
            snapshot.versions.length === count,
        'S3_OUTAGE_OBSERVER_SOURCE_COUNTS'
    );
    const document = snapshot.documents[0],
        location = snapshot.locations[0],
        first = snapshot.versions[0],
        latest = snapshot.versions.at(-1);
    need(
        id(document.id) &&
            document.organizationId === organization.id &&
            document.status === 'READY' &&
            document.deletedAt === null &&
            document.name === expected[ready ? 1 : 0].fileName &&
            id(location.id) &&
            location.organizationId === organization.id &&
            location.credentialId === null &&
            location.forcePathStyle === true,
        'S3_OUTAGE_OBSERVER_DOCUMENT'
    );
    for (const [index, version] of snapshot.versions.entries()) {
        const wanted = expected[index],
            task = version.ingestion;
        need(
            id(version.id) &&
                version.organizationId === organization.id &&
                version.documentId === document.id &&
                version.version === index + 1 &&
                version.sha256 === wanted.sha256 &&
                version.byteSize.toString() === String(wanted.bytes) &&
                version.fileName === wanted.fileName &&
                version.mediaType === 'text/plain' &&
                version.contentState === 'AVAILABLE' &&
                version.discardedAt === null &&
                Number.isFinite(instant(version.storedAt)) &&
                version.storageLocationId === location.id &&
                version.objectKey ===
                    `${organization.id}/${document.id}/${version.id}/original` &&
                task?.versionId === version.id &&
                task.organizationId === organization.id &&
                task.requestedBy === user.id &&
                Number.isInteger(version.tokenCount) &&
                version.tokenCount >= 0 &&
                version.tokenCount <= 1,
            'S3_OUTAGE_OBSERVER_VERSION_BINDING'
        );
        const published = index === 0 || ready;
        if (published) {
            const extraction = version.extraction;
            need(
                version.status === 'READY' &&
                    task.status === 'READY' &&
                    task.attempts === 1 &&
                    task.errorCode === null &&
                    task.reservedBytes.toString() === '0' &&
                    task.leasedUntil === null &&
                    version.tokenCount === 0 &&
                    extraction &&
                    id(extraction.id) &&
                    extraction.organizationId === organization.id &&
                    extraction.versionId === version.id &&
                    extraction.storageLocationId === location.id &&
                    extraction.objectKey ===
                        `${organization.id}/${document.id}/${version.id}/text.txt` &&
                    extraction.byteSize.toString() === String(wanted.bytes) &&
                    extraction.extractorVersion === 'utf8-text-v1' &&
                    extraction.language === 'und' &&
                    extraction.discardedAt === null,
                'S3_OUTAGE_OBSERVER_PUBLISHED'
            );
        } else {
            need(
                version.extraction === null &&
                    task.reservedBytes.toString() === String(wanted.bytes),
                'S3_OUTAGE_OBSERVER_RETAINED_RESERVATION'
            );
            if (failed)
                need(
                    version.status === 'FAILED' &&
                        task.status === 'FAILED' &&
                        task.attempts === 5 &&
                        task.errorCode === 'STORAGE_UNAVAILABLE' &&
                        task.leasedUntil === null &&
                        version.tokenCount === 0,
                    'S3_OUTAGE_OBSERVER_FAILED_FIFTH_CLAIM'
                );
            else if (!progress)
                need(
                    version.status === 'PROCESSING' &&
                        task.status === 'PENDING' &&
                        task.attempts === 0 &&
                        task.errorCode === null &&
                        task.leasedUntil === null &&
                        version.tokenCount === 0,
                    'S3_OUTAGE_OBSERVER_STAGED_ORIGINAL'
                );
            else
                need(
                    ['PROCESSING', 'FAILED'].includes(version.status) &&
                        ['PENDING', 'PROCESSING', 'FAILED'].includes(
                            task.status
                        ) &&
                        Number.isInteger(task.attempts) &&
                        task.attempts >= 0 &&
                        task.attempts <= 5 &&
                        [null, 'STORAGE_UNAVAILABLE'].includes(task.errorCode),
                    'S3_OUTAGE_OBSERVER_PROGRESS'
                );
        }
    }
    need(
        snapshot.tokenCount ===
            snapshot.versions.reduce((sum, row) => sum + row.tokenCount, 0) &&
            snapshot.cleanupTokenCount === 0,
        'S3_OUTAGE_OBSERVER_TOKEN_COUNT'
    );
    const cleanup = first.cleanup;
    if (baseline)
        need(cleanup === null, 'S3_OUTAGE_OBSERVER_UNEXPECTED_CLEANUP');
    else
        need(
            cleanup?.versionId === first.id &&
                cleanup.organizationId === organization.id &&
                cleanup.requestedBy === user.id &&
                cleanup.reason === 'REPLACED' &&
                cleanup.status === 'PENDING' &&
                cleanup.attempts === 0 &&
                cleanup.errorCode === null &&
                cleanup.leasedUntil === null &&
                cleanup.completedAt === null &&
                instant(cleanup.scheduledAt) > at &&
                instant(cleanup.availableAt) >= instant(cleanup.scheduledAt) &&
                Math.abs(
                    instant(cleanup.scheduledAt) -
                        instant(latest.createdAt) -
                        7 * 86400000
                ) <= 60000 &&
                latest.cleanup === null,
            'S3_OUTAGE_OBSERVER_SEVEN_DAY_RETENTION'
        );
    const expectedCounts = {
        'document.upload.reserved': 1,
        'document.upload.stored': count,
        'document.extraction.ready': ready ? 2 : 1,
        'document.replacement.reserved': baseline ? 0 : 1,
        'document.extraction.retried': ready ? 1 : 0,
    };
    need(
        snapshot.audits.length ===
            Object.values(expectedCounts).reduce(
                (sum, value) => sum + value,
                0
            ) &&
            snapshot.audits.every(
                (row) =>
                    row.organizationId === organization.id &&
                    row.targetId === document.id &&
                    sourceActions.includes(row.action)
            ) &&
            sourceActions.every(
                (action) =>
                    snapshot.audits.filter((row) => row.action === action)
                        .length === expectedCounts[action]
            ),
        'S3_OUTAGE_OBSERVER_AUDITS'
    );
    for (const action of sourceActions) {
        const wanted =
            action === 'document.upload.reserved'
                ? [first.id]
                : action === 'document.upload.stored'
                  ? snapshot.versions.map((row) => row.id)
                  : action === 'document.extraction.ready'
                    ? snapshot.versions
                          .filter((row) => row.extraction !== null)
                          .map((row) => row.id)
                    : action === 'document.replacement.reserved'
                      ? baseline
                          ? []
                          : [latest.id]
                      : ready
                        ? [latest.id]
                        : [];
        need(
            same(
                snapshot.audits
                    .filter((row) => row.action === action)
                    .map((row) => row.details?.versionId)
                    .sort(),
                wanted.toSorted()
            ),
            'S3_OUTAGE_OBSERVER_AUDIT_VERSION'
        );
    }
    if (!baseline) {
        const replacement = snapshot.audits.find(
            (row) => row.action === 'document.replacement.reserved'
        );
        need(
            replacement.details?.versionId === latest.id &&
                replacement.details.previousVersionId === first.id &&
                replacement.details.retentionDays === 7,
            'S3_OUTAGE_OBSERVER_NATIVE_RETENTION_INPUT'
        );
    }
    const v1BindingSha256 = sha(
        Buffer.from(canonical(immutableVersion(first)))
    );
    const v2OriginalBindingSha256 = baseline
        ? null
        : sha(Buffer.from(canonical(originalBinding(latest))));
    const cleanupSha256 = cleanup ? sha(Buffer.from(canonical(cleanup))) : null;
    if (previous) {
        need(
            previous.runId === fixture.runId &&
                previous.v1BindingSha256 === v1BindingSha256,
            'S3_OUTAGE_OBSERVER_V1_IMMUTABLE'
        );
        if (previous.v2OriginalBindingSha256)
            need(
                previous.v2OriginalBindingSha256 === v2OriginalBindingSha256 &&
                    previous.cleanupSha256 === cleanupSha256,
                'S3_OUTAGE_OBSERVER_V2_ORIGINAL_RETENTION_IMMUTABLE'
            );
        const beforeSessions = previous.snapshot.sessions;
        need(
            phase === 'signed-out' ||
                (beforeSessions.length === 1 &&
                    beforeSessions[0].id === snapshot.sessions[0].id),
            'S3_OUTAGE_OBSERVER_SAME_SESSION'
        );
    }
    const originalBytes = expected
            .slice(0, count)
            .reduce((sum, row) => sum + row.bytes, 0),
        extractionBytes = expected[0].bytes + (ready ? expected[1].bytes : 0);
    const reservedBytes = !baseline && !ready ? expected[1].bytes : 0;
    const state = taskState(latest.ingestion, at, latest.tokenCount),
        currentIngestion = latest.ingestion.status !== 'READY';
    return {
        servingVersion: ready ? 2 : 1,
        latestVersion: count,
        latestStatus: latest.status,
        contentReadableDuringOutage: 'NOT_ASSERTED',
        quota: {
            documents: 1,
            collections: 0,
            originalBytes,
            extractionBytes,
            reservedBytes,
            storageBytes: originalBytes + extractionBytes + reservedBytes,
        },
        operations: {
            currentIngestion: currentIngestion ? 1 : 0,
            failedIngestion: state === 'FAILED' ? 1 : 0,
            scheduledCleanup: baseline ? 0 : 1,
            dueCleanup: 0,
            failedCleanup: 0,
            indexing: 0,
            latestIngestionState: currentIngestion ? state : null,
            tokenCount: snapshot.tokenCount,
            liveClaim:
                latest.tokenCount === 1 &&
                ['UPLOADING', 'PROCESSING'].includes(latest.ingestion.status) &&
                instant(latest.ingestion.leasedUntil) > at,
            semantics: 'DERIVED_FROM_SCOPED_TASK_ROWS_NOT_OPERATIONS_HTTP',
        },
        v1BindingSha256,
        v2OriginalBindingSha256,
        cleanupSha256,
    };
}

/** Require every observed natural backoff and the terminal fifth failure; never infer a missing state. */
export function validateBackoffTrace(changes) {
    need(
        Array.isArray(changes) &&
            changes.length > 0 &&
            changes.length <= TRACE_LIMITS.changes,
        'S3_OUTAGE_TRACE_CHANGE_BOUND'
    );
    let priorObserved = -Infinity,
        priorAttempt = 0;
    for (const row of changes) {
        need(
            Number.isFinite(instant(row.observedAt)) &&
                instant(row.observedAt) >= priorObserved &&
                Number.isInteger(row.attempts) &&
                row.attempts >= priorAttempt &&
                row.attempts <= priorAttempt + 1 &&
                ['PENDING', 'PROCESSING', 'FAILED'].includes(row.status) &&
                [null, 'STORAGE_UNAVAILABLE'].includes(row.errorCode) &&
                row.tokenCount === (row.status === 'PROCESSING' ? 1 : 0),
            'S3_OUTAGE_TRACE_SEQUENCE'
        );
        priorObserved = instant(row.observedAt);
        priorAttempt = row.attempts;
    }
    need(
        changes.at(-1).status === 'FAILED' && changes.at(-1).attempts === 5,
        'S3_OUTAGE_TRACE_TERMINAL'
    );
    let priorDeadline = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        const failure = changes.find(
            (row) =>
                row.attempts === attempt &&
                row.status === (attempt === 5 ? 'FAILED' : 'PENDING')
        );
        need(
            failure?.errorCode === 'STORAGE_UNAVAILABLE' &&
                failure.tokenCount === 0,
            'S3_OUTAGE_TRACE_MISSING_FAILURE'
        );
        if (attempt < 5) {
            need(
                instant(failure.leasedUntil) === instant(failure.availableAt) &&
                    Math.abs(
                        instant(failure.availableAt) -
                            instant(failure.updatedAt) -
                            10000 * 2 ** attempt
                    ) <= 5000,
                'S3_OUTAGE_TRACE_BACKOFF'
            );
        } else
            need(
                failure.leasedUntil === null,
                'S3_OUTAGE_TRACE_TERMINAL_LEASE'
            );
        const evidence = changes.filter((row) => row.attempts === attempt);
        need(
            evidence.every(
                (row) =>
                    priorDeadline === null ||
                    instant(row.observedAt) >= priorDeadline
            ),
            'S3_OUTAGE_TRACE_EARLY_CLAIM'
        );
        priorDeadline = instant(failure.availableAt);
    }
    return {
        attempts: 5,
        observedBackoffMilliseconds: [20000, 40000, 80000, 160000],
        semantics:
            'ALL_FOUR_FAILURE_BACKOFFS_OBSERVED_NO_CLOCK_OR_TASK_MUTATION',
    };
}

/** Reuse the original 900-second watchdog; no observer creates a new fault window. */
export function watchdogTraceDeadline(
    ack,
    run,
    {
        monotonicNs = process.hrtime.bigint(),
        wallNow = Date.now(),
        performanceNow = performance.now(),
    } = {}
) {
    need(
        ack?.runId === run &&
            ack.budgetSeconds === 900 &&
            typeof ack.deadlineMonotonicNs === 'string' &&
            /^\d{1,30}$/u.test(ack.deadlineMonotonicNs),
        'S3_OUTAGE_OBSERVER_WATCHDOG_ACK'
    );
    const monotonicRemaining = Number(
            (BigInt(ack.deadlineMonotonicNs) - monotonicNs) / 1000000n
        ),
        wallRemaining = instant(ack.deadlineAt) - wallNow;
    need(
        Number.isFinite(wallRemaining) &&
            monotonicRemaining > 0 &&
            monotonicRemaining <= 900000 &&
            wallRemaining > 0 &&
            wallRemaining <= 900000,
        'S3_OUTAGE_OBSERVER_WATCHDOG_BUDGET'
    );
    return (
        performanceNow +
        Math.min(TRACE_LIMITS.milliseconds, monotonicRemaining, wallRemaining)
    );
}

/** Timer wakeups can be early; keep the two-second admission interval without assuming one complete sleep. */
export async function waitForNextSnapshot(
    target,
    deadline,
    {
        now = () => performance.now(),
        sleep = (milliseconds) =>
            new Promise((resolve) => setTimeout(resolve, milliseconds)),
    } = {}
) {
    let previous = now(),
        wakes = 0;
    while (previous < target) {
        need(
            previous < deadline && target < deadline && wakes++ < 64,
            'S3_OUTAGE_TRACE_INCOMPLETE'
        );
        await sleep(Math.max(1, Math.ceil(target - previous)));
        const current = now();
        need(
            current >= previous && current < deadline,
            'S3_OUTAGE_TRACE_INCOMPLETE'
        );
        previous = current;
    }
}

function project(snapshot) {
    return {
        observedAt: snapshot.observedAt,
        counts: snapshot.counts,
        user: snapshot.user,
        organization: snapshot.organization,
        members: snapshot.members,
        sessions: snapshot.sessions,
        document: snapshot.documents.map(
            ({ id, organizationId, name, status }) => ({
                id,
                organizationId,
                name,
                status,
            })
        ),
        tokenCount: snapshot.tokenCount,
        cleanupTokenCount: snapshot.cleanupTokenCount,
        versions: snapshot.versions.map((row) => ({
            id: row.id,
            version: row.version,
            sha256: row.sha256,
            bytes: row.byteSize.toString(),
            status: row.status,
            contentState: row.contentState,
            storedAt: row.storedAt,
            tokenCount: row.tokenCount,
            ingestion: row.ingestion,
            extraction: row.extraction
                ? {
                      id: row.extraction.id,
                      bytes: row.extraction.byteSize.toString(),
                      extractorVersion: row.extraction.extractorVersion,
                  }
                : null,
            cleanup: row.cleanup,
        })),
        audits: snapshot.audits.map((row) => ({
            action: row.action,
            versionId: row.details.versionId,
            ...(row.action === 'document.replacement.reserved'
                ? {
                      previousVersionId: row.details.previousVersionId,
                      retentionDays: row.details.retentionDays,
                  }
                : {}),
        })),
    };
}

async function main() {
    need(!STATIC_DRAFT_ONLY, 'S3_OUTAGE_OBSERVER_DRAFT_REVIEW_REQUIRED');
    const args = process.argv.slice(2);
    need(
        args.length === 6 && args[4] === '--phase' && PHASES.includes(args[5]),
        'S3_OUTAGE_OBSERVER_ARGUMENTS'
    );
    const phase = args[5],
        purpose =
            phase === 'v2-staged'
                ? 'staged-observe'
                : phase === 'outage-failed'
                  ? 'outage-observe'
                  : 'observe';
    const { state, run, directory, recheck } = context(
        args.slice(0, 4),
        purpose
    );
    need(state.scenario === 'INGESTION_V1', 'S3_OUTAGE_INGESTION_SCENARIO');
    const fixture = privateJson(path.join(directory, 'fixture.json'), 16384);
    need(sameScope(state, fixture), 'S3_OUTAGE_FIXTURE_PROTOCOL');
    need(
        fixture.namespace === state.namespace &&
            fixture.runId === run &&
            state.environment.VECTORIX_DEFAULT_S3_ENDPOINT ===
                `http://127.0.0.1:${state.ports.rustfs}`,
        'S3_OUTAGE_OBSERVER_PLATFORM_BINDING'
    );
    const expectedMetadata = JSON.parse(
        publicBytes('expected.json', state).toString('utf8')
    );
    const originals = [
            publicBytes('s3-outage-v1.txt', state),
            publicBytes('s3-outage-v2.txt', state),
        ],
        expected = validateFixtures(expectedMetadata, originals);
    const previousPhase = PHASES[PHASES.indexOf(phase) - 1],
        previous = previousPhase
            ? privateJson(
                  path.join(directory, `observe-${previousPhase}.json`),
                  32768
              )
            : null;
    need(
        !previous ||
            (sameScope(state, previous) &&
                previous.phase === previousPhase &&
                previous.status === 'OBSERVED' &&
                previous.namespace === state.namespace),
        'S3_OUTAGE_OBSERVER_PHASE_CHAIN'
    );
    const fixtureSha256 = sha(Buffer.from(canonical(fixture)));
    need(
        !previous || previous.fixtureSha256 === fixtureSha256,
        'S3_OUTAGE_OBSERVER_FIXTURE_CHAIN'
    );
    writePrivate(path.join(directory, `observe-${phase}-intent.json`), {
        ...receiptScope(state),
        namespace: state.namespace,
        runId: run,
        phase,
        fixtureSha256,
        status: 'ONE_SHOT_READ_ONLY_STARTED',
    });
    let client, objects;
    const changes = [];
    let snapshots = 0,
        lastSnapshot,
        watchdogProof = null;
    try {
        client = await openFixturePrisma(state, true);
        const capture = () =>
            client.$transaction((tx) => readSnapshot(tx, fixture), {
                isolationLevel: 'RepeatableRead',
                maxWait: 1000,
                timeout: 15000,
            });
        let snapshot;
        if (phase === 'outage-failed') {
            const ackBytes = privateBytes(
                    path.join(directory, 'watchdog-ack.json'),
                    16384
                ),
                ack = JSON.parse(ackBytes.toString('utf8'));
            watchdogProof = {
                ackSha256: sha(ackBytes),
                deadlineAt: ack.deadlineAt,
                deadlineMonotonicNs: ack.deadlineMonotonicNs,
                budgetSeconds: 900,
                observerMaximumMilliseconds: TRACE_LIMITS.milliseconds,
            };
            const stop = watchdogTraceDeadline(ack, run);
            while (true) {
                need(
                    performance.now() < stop &&
                        snapshots < TRACE_LIMITS.snapshots &&
                        !fs.existsSync(
                            path.join(directory, 'watchdog-intervention.json')
                        ),
                    'S3_OUTAGE_TRACE_INCOMPLETE'
                );
                recheck();
                need(performance.now() < stop, 'S3_OUTAGE_TRACE_INCOMPLETE');
                snapshot = await capture();
                snapshots++;
                lastSnapshot = snapshot;
                need(performance.now() < stop, 'S3_OUTAGE_TRACE_INCOMPLETE');
                assessSnapshot(
                    snapshot,
                    'outage-progress',
                    fixture,
                    expected,
                    previous
                );
                const version = snapshot.versions[1],
                    task = version.ingestion;
                const row = stringifySafe({
                    observedAt: snapshot.observedAt,
                    status: task.status,
                    attempts: task.attempts,
                    errorCode: task.errorCode,
                    tokenCount: version.tokenCount,
                    leasedUntil: task.leasedUntil,
                    availableAt: task.availableAt,
                    updatedAt: task.updatedAt,
                });
                const identity = ({ observedAt, ...rest }) => canonical(rest);
                if (
                    !changes.length ||
                    identity(changes.at(-1)) !== identity(row)
                ) {
                    need(
                        changes.length < TRACE_LIMITS.changes,
                        'S3_OUTAGE_TRACE_CHANGE_BOUND'
                    );
                    changes.push(row);
                }
                if (task.status === 'FAILED') break;
                need(
                    performance.now() + TRACE_LIMITS.intervalMs < stop,
                    'S3_OUTAGE_TRACE_INCOMPLETE'
                );
                await waitForNextSnapshot(
                    performance.now() + TRACE_LIMITS.intervalMs,
                    stop
                );
            }
            validateBackoffTrace(changes);
        } else {
            snapshot = await capture();
            snapshots = 1;
            lastSnapshot = snapshot;
        }
        const assessed = assessSnapshot(
                snapshot,
                phase,
                fixture,
                expected,
                previous
            ),
            location = snapshot.locations[0];
        need(
            location.endpoint ===
                state.environment.VECTORIX_DEFAULT_S3_ENDPOINT &&
                location.bucket ===
                    state.environment.VECTORIX_DEFAULT_S3_BUCKET &&
                location.region ===
                    state.environment.VECTORIX_DEFAULT_S3_REGION,
            'S3_OUTAGE_OBSERVER_SAVED_STORAGE_BINDING'
        );
        const rawMetadataSha256 = sha(
                Buffer.from(canonical(snapshot.versions))
            ),
            objectProof = [];
        if (phase !== 'outage-failed') {
            const bindings = snapshot.versions.map((row, index) => ({
                documentId: row.documentId,
                versionId: row.id,
                version: row.version,
                sha256: expected[index].sha256,
                byteSize: expected[index].bytes,
                extractionPresent: row.extraction !== null,
            }));
            objects = createReadOnlyObjectObserver({
                state,
                fixture,
                bindings,
                phase,
                admit: recheck,
            });
            for (const [index, version] of snapshot.versions.entries()) {
                const input = {
                    organizationId: fixture.organization.id,
                    documentId: version.documentId,
                    versionId: version.id,
                    location,
                    byteSize: expected[index].bytes,
                    expectedSha256: expected[index].sha256,
                };
                const original = await objects.read({
                    ...input,
                    key: version.objectKey,
                    kind: 'original',
                });
                need(
                    original.bytes.equals(originals[index]),
                    'S3_OUTAGE_OBSERVER_ORIGINAL_BYTES'
                );
                const artifactKey = `${fixture.organization.id}/${version.documentId}/${version.id}/text.txt`;
                if (version.extraction) {
                    const artifact = await objects.read({
                        ...input,
                        key: artifactKey,
                        kind: 'artifact',
                    });
                    need(
                        artifact.bytes.equals(originals[index]),
                        'S3_OUTAGE_OBSERVER_CANONICAL_BYTES'
                    );
                    objectProof.push({
                        version: version.version,
                        originalSha256: original.sha256,
                        originalBytes: original.byteSize,
                        extractionSha256: artifact.sha256,
                        extractionBytes: artifact.byteSize,
                    });
                } else {
                    await objects.absentArtifact({
                        ...input,
                        key: artifactKey,
                        kind: 'artifact',
                    });
                    objectProof.push({
                        version: version.version,
                        originalSha256: original.sha256,
                        originalBytes: original.byteSize,
                        extraction: 'ABSENT_CONFIRMED_BY_HEAD_404',
                    });
                }
            }
            recheck();
            const after = await capture();
            assessSnapshot(after, phase, fixture, expected, previous);
            need(
                sha(Buffer.from(canonical(after.versions))) ===
                    rawMetadataSha256 &&
                    same(snapshot.user, after.user) &&
                    same(snapshot.organization, after.organization) &&
                    same(snapshot.members, after.members) &&
                    same(snapshot.sessions, after.sessions) &&
                    same(snapshot.locations, after.locations),
                'S3_OUTAGE_OBSERVER_METADATA_CHANGED_DURING_IO'
            );
        }
        recheck();
        need(
            !fs.existsSync(path.join(directory, 'watchdog-intervention.json')),
            'S3_OUTAGE_OBSERVER_WATCHDOG_INTERVENED'
        );
        if (watchdogProof)
            need(
                sha(
                    privateBytes(
                        path.join(directory, 'watchdog-ack.json'),
                        16384
                    )
                ) === watchdogProof.ackSha256,
                'S3_OUTAGE_OBSERVER_WATCHDOG_ACK_CHANGED'
            );
        const result = stringifySafe({
            ...receiptScope(state),
            namespace: state.namespace,
            runId: run,
            phase,
            status: 'OBSERVED',
            fixtureSha256,
            scope:
                phase === 'outage-failed'
                    ? 'READ_ONLY_APPLICATION_DATABASE_NO_S3_SDK'
                    : 'READ_ONLY_DATABASE_AND_EXACT_PLATFORM_S3',
            browserAcceptance: 'NOT_DETERMINED',
            snapshot: project(snapshot),
            ...assessed,
            rawMetadataSha256,
            objectProof,
            objectReadSummary: objects?.summary() ?? {
                originals: 0,
                artifacts: 0,
                absentArtifacts: 0,
                requests: 0,
                objectBytes: 0,
                scope: 'NO_S3_SDK_CREATED',
            },
            trace:
                phase === 'outage-failed'
                    ? {
                          snapshots,
                          changes,
                          watchdog: watchdogProof,
                          ...validateBackoffTrace(changes),
                      }
                    : null,
            crossStoreConsistency:
                phase === 'outage-failed'
                    ? 'DATABASE_SNAPSHOT_ONLY_SOURCE_READABILITY_NOT_ASSERTED'
                    : 'METADATA_RECHECKED_NOT_CROSS_STORE_ATOMIC',
            cleanup:
                'SEVEN_DAY_RETENTION_PRESERVED_NOT_A_CLEANUP_COMPLETION_TEST',
        });
        const first = snapshot.versions[0],
            latest = snapshot.versions.at(-1),
            common = {
                schemaVersion: 1,
                organizationId: fixture.organization.id,
                documentId: latest.documentId,
                versionId: latest.id,
                version: latest.version,
                originalSha256: latest.sha256,
                observedAt: snapshot.observedAt,
            };
        if (phase === 'v1-ready')
            result.faultEnrollmentAdmission = {
                ...common,
                kind: 'V1_READY_IDLE',
                liveClaims: 0,
                workerPid: state.processes.workers.pid,
                workerStartTicks: state.processes.workers.startTicks,
                rustfsContainerId: state.resources.rustfs.id,
            };
        if (phase === 'v2-staged')
            result.faultAdmission = {
                ...common,
                kind: 'STAGED_ORIGINAL_CONFIRMED',
                stored: true,
                ingestionStatus: 'PENDING',
                attempts: 0,
                extractionPresent: false,
                workerPid: state.processes.workers.pid,
                workerStartTicks: state.processes.workers.startTicks,
                rustfsContainerId: state.resources.rustfs.id,
            };
        if (phase === 'outage-failed')
            result.faultRecoveryAdmission = {
                ...common,
                kind: 'EXTRACTION_FAILED',
                attempts: 5,
                status: 'FAILED',
                errorCode: 'STORAGE_UNAVAILABLE',
            };
        need(
            first.version === 1 && hash(result.v1BindingSha256),
            'S3_OUTAGE_OBSERVER_FINAL_SCOPE'
        );
        writePrivate(path.join(directory, `observe-${phase}.json`), result);
        console.log(
            JSON.stringify({
                completed: true,
                runId: run,
                phase,
                servingVersion: assessed.servingVersion,
                latestVersion: assessed.latestVersion,
                latestStatus: assessed.latestStatus,
                storageBytes: assessed.quota.storageBytes,
                reservedBytes: assessed.quota.reservedBytes,
                snapshots,
                status: 'OBSERVED',
                browserAcceptance: 'NOT_DETERMINED',
            })
        );
    } catch (error) {
        try {
            writePrivate(
                path.join(directory, `observe-${phase}-incomplete.json`),
                {
                    ...receiptScope(state),
                    namespace: state.namespace,
                    runId: run,
                    phase,
                    status: 'INCOMPLETE',
                    scope: 'PARTIAL_READ_ONLY_EVIDENCE_NOT_PASS',
                    snapshots,
                    changes,
                    lastObservedAt: lastSnapshot?.observedAt ?? null,
                }
            );
        } catch {
            /* Original intent/output remains immutable. */
        }
        throw error;
    } finally {
        objects?.close();
        if (client) await client.$disconnect();
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
