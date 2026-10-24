/** One-version cleanup evidence. Outage sampling is DB-only; online S3 I/O is followed by a metadata reread. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
    context,
    need,
    HERE,
    receiptScope,
    sameScope,
    privateBytes,
    privateJson,
    writePrivate,
    openFixturePrisma,
    entryError,
} from './private.mjs';
import {
    readSnapshot,
    watchdogTraceDeadline,
    waitForNextSnapshot,
} from './observe.mjs';
import { createReadOnlyObjectObserver } from './objects.mjs';

export const STATIC_DRAFT_ONLY = true;
export const CLEANUP_PHASES = Object.freeze([
    'cleanup-ready',
    'cleanup-staged',
    'cleanup-outage-failed',
    'cleanup-restored-before-retry',
    'cleanup-complete',
    'cleanup-signed-out',
]);
export const CLEANUP_TRACE_LIMITS = Object.freeze({
    snapshots: 360,
    changes: 16,
    milliseconds: 720000,
    intervalMs: 2000,
});
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) =>
    JSON.stringify(value, (_key, item) =>
        typeof item === 'bigint' ? item.toString() : item
    );
const same = (a, b) => json(a) === json(b);
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const instant = (value) =>
    value instanceof Date
        ? value.getTime()
        : typeof value === 'string' && /(?:Z|\+00:00)$/u.test(value)
          ? Date.parse(value)
          : NaN;
const metadataHash = ({ observedAt: _at, ...value }) => sha(json(value));

/** Bind the existing quota aggregate to the same read-only snapshot, rather than treating telemetry as accounting. */
export async function readCleanupSnapshot(tx, fixture) {
    const snapshot = await readSnapshot(tx, fixture),
        organizationId = fixture.organization.id;
    const [originals, extractions, reservations, indexTasks] =
        await Promise.all([
            tx.documentVersion.aggregate({
                where: { organizationId, discardedAt: null },
                _sum: { byteSize: true },
            }),
            tx.documentExtraction.aggregate({
                where: { organizationId, discardedAt: null },
                _sum: { byteSize: true },
            }),
            tx.documentIngestion.aggregate({
                where: { organizationId },
                _sum: { reservedBytes: true },
            }),
            tx.indexTask.count(),
        ]);
    snapshot.quota = {
        originalBytes: String(originals._sum.byteSize ?? 0n),
        extractionBytes: String(extractions._sum.byteSize ?? 0n),
        reservedBytes: String(reservations._sum.reservedBytes ?? 0n),
        storageBytes: String(
            (originals._sum.byteSize ?? 0n) +
                (extractions._sum.byteSize ?? 0n) +
                (reservations._sum.reservedBytes ?? 0n)
        ),
    };
    snapshot.indexTasks = indexTasks;
    return snapshot;
}

/** An immutable source binding excludes only state/discard markers changed by normal cleanup. */
function sourceBinding(snapshot) {
    const v = snapshot.versions[0],
        x = v.extraction;
    return {
        documentId: v.documentId,
        versionId: v.id,
        version: v.version,
        organizationId: v.organizationId,
        storageLocationId: v.storageLocationId,
        objectKey: v.objectKey,
        sha256: v.sha256,
        byteSize: v.byteSize,
        fileName: v.fileName,
        mediaType: v.mediaType,
        storedAt: v.storedAt,
        createdAt: v.createdAt,
        location: snapshot.locations[0],
        extraction: {
            id: x.id,
            versionId: x.versionId,
            organizationId: x.organizationId,
            storageLocationId: x.storageLocationId,
            objectKey: x.objectKey,
            byteSize: x.byteSize,
            extractorVersion: x.extractorVersion,
            language: x.language,
            createdAt: x.createdAt,
        },
    };
}

/** Validate current catalog state without changing claims, retries, retention, or rights. */
export function assessCleanupSnapshot(
    snapshot,
    phase,
    fixture,
    expected,
    previous = null
) {
    need(
        CLEANUP_PHASES.includes(phase) || phase === 'cleanup-progress',
        'S3_OUTAGE_CLEANUP_PHASE'
    );
    const baseline = phase === 'cleanup-ready',
        staged = phase === 'cleanup-staged',
        complete = ['cleanup-complete', 'cleanup-signed-out'].includes(phase),
        progress = phase === 'cleanup-progress',
        sessions = phase === 'cleanup-signed-out' ? 0 : 1,
        at = instant(snapshot.observedAt);
    need(
        fixture.protocolVersion === 2 &&
            fixture.scenario === 'CLEANUP_V1' &&
            fixture.namespace === 'vectorix-m7c-s3-cleanup' &&
            /^[a-f0-9]{12}$/u.test(fixture.runId) &&
            fixture.setup?.directWrites === 'NONE_NATIVE_HTTP_ONLY' &&
            Number.isFinite(at),
        'S3_OUTAGE_CLEANUP_FIXTURE'
    );
    const counts = {
        users: 1,
        organizations: 1,
        members: 1,
        sessions,
        documents: 1,
        versions: 1,
        extractions: 1,
        cleanups: baseline ? 0 : 1,
    };
    need(
        Object.entries(snapshot.counts).every(
            ([name, value]) => value === (counts[name] ?? 0)
        ) &&
            Object.keys(counts).every(
                (name) => snapshot.counts[name] === counts[name]
            ) &&
            snapshot.indexTasks === 0,
        'S3_OUTAGE_CLEANUP_COUNTS'
    );
    const owner = fixture.users.owner,
        org = fixture.organization,
        document = snapshot.documents[0],
        v = snapshot.versions[0],
        location = snapshot.locations[0],
        ingestion = v?.ingestion,
        x = v?.extraction,
        task = v?.cleanup;
    need(
        snapshot.user?.id === owner.userId &&
            snapshot.user.isSuperAdmin === false &&
            snapshot.user.emailVerified === false &&
            ['en', 'fr', 'nl-BE'].includes(snapshot.user.locale) &&
            snapshot.organization?.id === org.id &&
            snapshot.organization.isActive === true &&
            snapshot.organization.slug ===
                `m7c-s3-cleanup-${fixture.runId}-owner` &&
            same(snapshot.members, fixture.membershipSnapshot) &&
            snapshot.members.length === 1 &&
            snapshot.members[0].role === 'owner',
        'S3_OUTAGE_CLEANUP_OWNER'
    );
    need(
        snapshot.sessions.length === sessions &&
            snapshot.sessions.every(
                (row) =>
                    id(row.id) &&
                    row.userId === owner.userId &&
                    row.activeOrganizationId === org.id &&
                    instant(row.expiresAt) > at
            ),
        'S3_OUTAGE_CLEANUP_SESSION'
    );
    need(
        snapshot.documents.length === 1 &&
            snapshot.versions.length === 1 &&
            snapshot.locations.length === 1 &&
            id(document?.id) &&
            document.organizationId === org.id &&
            document.name === expected.fileName &&
            document.status === (baseline ? 'READY' : 'DELETED') &&
            (baseline
                ? document.deletedAt === null
                : Number.isFinite(instant(document.deletedAt))),
        'S3_OUTAGE_CLEANUP_DOCUMENT'
    );
    need(
        id(v?.id) &&
            v.documentId === document.id &&
            v.organizationId === org.id &&
            v.version === 1 &&
            v.fileName === expected.fileName &&
            v.mediaType === 'text/plain' &&
            v.sha256 === expected.sha256 &&
            String(v.byteSize) === String(expected.bytes) &&
            Number.isFinite(instant(v.storedAt)) &&
            id(location?.id) &&
            location.organizationId === org.id &&
            location.credentialId === null &&
            v.storageLocationId === location.id &&
            v.objectKey === `${org.id}/${document.id}/${v.id}/original`,
        'S3_OUTAGE_CLEANUP_VERSION'
    );
    need(
        ingestion?.versionId === v.id &&
            ingestion.organizationId === org.id &&
            ingestion.requestedBy === owner.userId &&
            ingestion.status === (baseline ? 'READY' : 'FAILED') &&
            ingestion.errorCode === (baseline ? null : 'ACCESS_REVOKED') &&
            ingestion.attempts === 1 &&
            String(ingestion.reservedBytes) === '0' &&
            ingestion.leasedUntil === null &&
            v.tokenCount === 0 &&
            snapshot.tokenCount === 0,
        'S3_OUTAGE_CLEANUP_IDLE_INGESTION'
    );
    need(
        id(x?.id) &&
            x.versionId === v.id &&
            x.organizationId === org.id &&
            x.storageLocationId === location.id &&
            x.objectKey === `${org.id}/${document.id}/${v.id}/text.txt` &&
            String(x.byteSize) === String(expected.bytes) &&
            x.extractorVersion === 'utf8-text-v1' &&
            x.language === 'und',
        'S3_OUTAGE_CLEANUP_EXTRACTION'
    );
    need(
        v.status === (baseline ? 'READY' : 'DELETED') &&
            (complete
                ? v.contentState === 'PURGED' &&
                  Number.isFinite(instant(v.discardedAt)) &&
                  Number.isFinite(instant(x.discardedAt))
                : v.discardedAt === null &&
                  x.discardedAt === null &&
                  (baseline || staged
                      ? v.contentState === 'AVAILABLE'
                      : progress
                        ? ['AVAILABLE', 'DELETING'].includes(v.contentState)
                        : v.contentState === 'DELETING')),
        'S3_OUTAGE_CLEANUP_CONTENT'
    );
    if (baseline)
        need(
            task === null && snapshot.cleanupTokenCount === 0,
            'S3_OUTAGE_CLEANUP_BASELINE_NO_TASK'
        );
    else {
        need(
            task?.versionId === v.id &&
                task.organizationId === org.id &&
                task.requestedBy === owner.userId &&
                task.reason === 'DELETED' &&
                instant(task.scheduledAt) === instant(document.deletedAt) &&
                instant(task.availableAt) >= instant(task.scheduledAt) &&
                Number.isInteger(task.attempts) &&
                task.attempts >= 0 &&
                task.attempts <= 5,
            'S3_OUTAGE_CLEANUP_TASK_BINDING'
        );
        if (staged)
            need(
                task.status === 'PENDING' &&
                    task.attempts === 0 &&
                    task.errorCode === null &&
                    task.leasedUntil === null &&
                    task.completedAt === null &&
                    snapshot.cleanupTokenCount === 0,
                'S3_OUTAGE_CLEANUP_STAGED'
            );
        else if (complete)
            need(
                task.status === 'COMPLETE' &&
                    task.attempts === 1 &&
                    task.errorCode === null &&
                    task.leasedUntil === null &&
                    Number.isFinite(instant(task.completedAt)) &&
                    snapshot.cleanupTokenCount === 0,
                'S3_OUTAGE_CLEANUP_COMPLETE'
            );
        else if (!progress)
            need(
                task.status === 'FAILED' &&
                    task.attempts === 5 &&
                    task.errorCode === 'STORAGE_UNAVAILABLE' &&
                    task.leasedUntil === null &&
                    task.completedAt === null &&
                    snapshot.cleanupTokenCount === 0,
                'S3_OUTAGE_CLEANUP_FAILED_FIFTH'
            );
        else
            need(
                ['PENDING', 'PROCESSING', 'FAILED'].includes(task.status) &&
                    [null, 'STORAGE_UNAVAILABLE'].includes(task.errorCode) &&
                    task.completedAt === null &&
                    snapshot.cleanupTokenCount ===
                        (task.status === 'PROCESSING' ? 1 : 0) &&
                    (task.status === 'PROCESSING'
                        ? instant(task.leasedUntil) > at
                        : task.leasedUntil === null),
                'S3_OUTAGE_CLEANUP_PROGRESS'
            );
    }
    const expectedAudits = {
        'document.upload.reserved': 1,
        'document.upload.stored': 1,
        'document.extraction.ready': 1,
        ...(baseline ? {} : { 'document.deleted': 1 }),
        ...(complete
            ? { 'document.cleanup.retried': 1, 'document.cleanup.complete': 1 }
            : {}),
    };
    need(
        snapshot.audits.length ===
            Object.values(expectedAudits).reduce(
                (sum, value) => sum + value,
                0
            ) &&
            snapshot.audits.every(
                (row) =>
                    row.organizationId === org.id &&
                    row.targetId === document.id &&
                    Object.hasOwn(expectedAudits, row.action)
            ) &&
            Object.entries(expectedAudits).every(
                ([action, count]) =>
                    snapshot.audits.filter((row) => row.action === action)
                        .length === count
            ),
        'S3_OUTAGE_CLEANUP_AUDITS'
    );
    for (const row of snapshot.audits)
        need(
            row.action === 'document.deleted'
                ? row.details?.retentionDays === 0 && row.details.versions === 1
                : row.details?.versionId === v.id,
            'S3_OUTAGE_CLEANUP_AUDIT_VERSION'
        );
    const sourceSha256 = sha(json(sourceBinding(snapshot))),
        scheduleSha256 = task
            ? sha(
                  json({
                      versionId: task.versionId,
                      organizationId: task.organizationId,
                      requestedBy: task.requestedBy,
                      reason: task.reason,
                      scheduledAt: task.scheduledAt,
                      createdAt: task.createdAt,
                      deletedAt: document.deletedAt,
                  })
              )
            : null;
    if (previous)
        need(
            previous.runId === fixture.runId &&
                previous.scenario === 'CLEANUP_V1' &&
                previous.sourceSha256 === sourceSha256 &&
                (!previous.scheduleSha256 ||
                    previous.scheduleSha256 === scheduleSha256) &&
                (sessions === 0 ||
                    previous.sessionId === snapshot.sessions[0].id),
            'S3_OUTAGE_CLEANUP_IMMUTABLE'
        );
    const retained = complete ? 0 : expected.bytes;
    need(
        same(snapshot.quota, {
            originalBytes: String(retained),
            extractionBytes: String(retained),
            reservedBytes: '0',
            storageBytes: String(retained * 2),
        }),
        'S3_OUTAGE_CLEANUP_QUOTA'
    );
    return {
        sourceSha256,
        scheduleSha256,
        sessionId: snapshot.sessions[0]?.id ?? null,
        quota: snapshot.quota,
        historicalIngestion: baseline
            ? 'READY'
            : 'FAILED_ACCESS_REVOKED_NOT_RUNNABLE',
        sourceReadabilityDuringOutage: 'NOT_ASSERTED',
        cleanup: task
            ? {
                  versionId: task.versionId,
                  status: task.status,
                  attempts: task.attempts,
                  errorCode: task.errorCode,
                  scheduledAt: task.scheduledAt,
                  availableAt: task.availableAt,
                  leasedUntil: task.leasedUntil,
                  completedAt: task.completedAt,
                  updatedAt: task.updatedAt,
                  tokenCount: snapshot.cleanupTokenCount,
              }
            : null,
        source: {
            organizationId: org.id,
            documentId: document.id,
            versionId: v.id,
            version: 1,
            originalSha256: v.sha256,
        },
        tombstoneRetained: !baseline,
        purged: complete,
        unresolvedIndexWork: 0,
        sourceHolds: 0,
    };
}

/** Every backoff must be observed; absence of a sampled state is INCOMPLETE, never inferred. */
export function validateCleanupTrace(changes) {
    need(
        Array.isArray(changes) &&
            changes.length > 0 &&
            changes.length <= CLEANUP_TRACE_LIMITS.changes,
        'S3_OUTAGE_CLEANUP_TRACE_BOUND'
    );
    let priorAt = -Infinity,
        priorAttempt = 0;
    for (const row of changes) {
        need(
            instant(row.observedAt) >= priorAt &&
                Number.isInteger(row.attempts) &&
                row.attempts >= priorAttempt &&
                row.attempts <= priorAttempt + 1 &&
                ['PENDING', 'PROCESSING', 'FAILED'].includes(row.status) &&
                [null, 'STORAGE_UNAVAILABLE'].includes(row.errorCode) &&
                row.tokenCount === (row.status === 'PROCESSING' ? 1 : 0),
            'S3_OUTAGE_CLEANUP_TRACE_SEQUENCE'
        );
        priorAt = instant(row.observedAt);
        priorAttempt = row.attempts;
    }
    let priorDeadline = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        const row = changes.find(
            (item) =>
                item.attempts === attempt &&
                item.status === (attempt === 5 ? 'FAILED' : 'PENDING')
        );
        need(
            row?.errorCode === 'STORAGE_UNAVAILABLE' &&
                row.tokenCount === 0 &&
                row.leasedUntil === null,
            'S3_OUTAGE_CLEANUP_TRACE_MISSING_FAILURE'
        );
        need(
            changes
                .filter((item) => item.attempts === attempt)
                .every(
                    (item) =>
                        priorDeadline === null ||
                        instant(item.observedAt) >= priorDeadline
                ),
            'S3_OUTAGE_CLEANUP_TRACE_EARLY'
        );
        if (attempt < 5)
            need(
                Math.abs(
                    instant(row.availableAt) -
                        instant(row.updatedAt) -
                        10000 * 2 ** attempt
                ) <= 5000,
                'S3_OUTAGE_CLEANUP_TRACE_BACKOFF'
            );
        priorDeadline = instant(row.availableAt);
    }
    need(
        instant(
            changes.find((row) => row.attempts === 5 && row.status === 'FAILED')
                ?.updatedAt
        ) -
            instant(
                changes.find(
                    (row) => row.attempts === 1 && row.status === 'PENDING'
                )?.updatedAt
            ) >=
            300000,
        'S3_OUTAGE_CLEANUP_TRACE_MINIMUM_DURATION'
    );
    need(
        changes.at(-1).status === 'FAILED' && changes.at(-1).attempts === 5,
        'S3_OUTAGE_CLEANUP_TRACE_TERMINAL'
    );
    return {
        attempts: 5,
        observedBackoffMilliseconds: [20000, 40000, 80000, 160000],
        semantics: 'DESTRUCTIVE_CLAIMS_NOT_S3_WIRE_REQUEST_COUNT',
    };
}

async function main() {
    need(
        !STATIC_DRAFT_ONLY,
        'S3_OUTAGE_CLEANUP_OBSERVER_DRAFT_REVIEW_REQUIRED'
    );
    const args = process.argv.slice(2);
    need(
        args.length === 6 &&
            args[4] === '--phase' &&
            CLEANUP_PHASES.includes(args[5]),
        'S3_OUTAGE_CLEANUP_OBSERVER_ARGUMENTS'
    );
    const phase = args[5],
        purpose =
            phase === 'cleanup-staged'
                ? 'staged-observe'
                : phase === 'cleanup-outage-failed'
                  ? 'outage-observe'
                  : 'observe';
    const { state, directory, recheck } = context(args.slice(0, 4), purpose);
    need(state.scenario === 'CLEANUP_V1', 'S3_OUTAGE_CLEANUP_SCENARIO');
    const fixture = privateJson(path.join(directory, 'fixture.json'), 16384);
    need(sameScope(state, fixture), 'S3_OUTAGE_CLEANUP_FIXTURE_PROTOCOL');
    const metadataFile = path.join(HERE, 'fixtures/expected.json'),
        textFile = path.join(HERE, 'fixtures/s3-outage-v1.txt');
    function fixtureBytes(file) {
        const fd = fs.openSync(
            file,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        );
        try {
            const info = fs.fstatSync(fd),
                bytes = fs.readFileSync(fd),
                pin = state.inputs.textFixtures[path.basename(file)];
            need(
                info.isFile() &&
                    info.uid === process.getuid() &&
                    (info.mode & 0o002) === 0 &&
                    info.size <= 16384 &&
                    bytes.length === info.size &&
                    bytes.length === pin.bytes &&
                    sha(bytes) === pin.sha256,
                'S3_OUTAGE_CLEANUP_FIXTURE_PIN'
            );
            return bytes;
        } finally {
            fs.closeSync(fd);
        }
    }
    const expected = JSON.parse(fixtureBytes(metadataFile)).versions[0],
        text = fixtureBytes(textFile);
    need(
        expected.version === 1 &&
            expected.fileName === 's3-outage-v1.txt' &&
            expected.bytes === text.length &&
            expected.sha256 === sha(text) &&
            expected.canonicalSha256 === expected.sha256 &&
            expected.canonicalBytes === expected.bytes &&
            expected.extractorVersion === 'utf8-text-v1',
        'S3_OUTAGE_CLEANUP_EXPECTED'
    );
    const previousPhase = CLEANUP_PHASES[CLEANUP_PHASES.indexOf(phase) - 1],
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
                previous.status === 'OBSERVED'),
        'S3_OUTAGE_CLEANUP_PHASE_CHAIN'
    );
    const fixtureSha256 = sha(json(fixture));
    need(
        !previous || previous.fixtureSha256 === fixtureSha256,
        'S3_OUTAGE_CLEANUP_FIXTURE_CHANGED'
    );
    writePrivate(path.join(directory, `observe-${phase}-intent.json`), {
        ...receiptScope(state),
        phase,
        fixtureSha256,
        status: 'ONE_SHOT_READ_ONLY',
    });
    let client,
        objects,
        snapshots = 0,
        latest;
    const changes = [];
    try {
        if (phase === 'cleanup-staged') {
            const deleted = privateJson(
                path.join(directory, 'cleanup-delete-receipt.json'),
                16384
            );
            need(
                sameScope(state, deleted) &&
                    deleted.acceptance === 'CONFIRMED_NATIVE_HTTP' &&
                    deleted.signOutConfirmed === true &&
                    deleted.documentId === previous.source.documentId &&
                    deleted.versionId === previous.source.versionId &&
                    deleted.retentionDays === 0,
                'S3_OUTAGE_CLEANUP_DELETE_RECEIPT'
            );
        }
        client = await openFixturePrisma(state, true);
        const snapshot = async () => {
            recheck();
            const value = await client.$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
                    await tx.$executeRawUnsafe(
                        'SET LOCAL statement_timeout = 10000'
                    );
                    return readCleanupSnapshot(tx, fixture);
                },
                {
                    isolationLevel: 'RepeatableRead',
                    maxWait: 1000,
                    timeout: 15000,
                }
            );
            recheck();
            return value;
        };
        let assessed,
            ackBytes = null,
            trace = null;
        if (phase === 'cleanup-outage-failed') {
            ackBytes = privateBytes(
                path.join(directory, 'watchdog-ack.json'),
                16384
            );
            const ack = JSON.parse(ackBytes);
            need(sameScope(state, ack), 'S3_OUTAGE_CLEANUP_ACK_SCOPE');
            const deadline = watchdogTraceDeadline(ack, state.runId);
            while (true) {
                need(
                    snapshots < CLEANUP_TRACE_LIMITS.snapshots &&
                        performance.now() < deadline &&
                        !fs.existsSync(
                            path.join(directory, 'watchdog-intervention.json')
                        ),
                    'S3_OUTAGE_CLEANUP_TRACE_INCOMPLETE'
                );
                latest = await snapshot();
                snapshots++;
                need(
                    performance.now() < deadline,
                    'S3_OUTAGE_CLEANUP_TRACE_INCOMPLETE'
                );
                assessed = assessCleanupSnapshot(
                    latest,
                    'cleanup-progress',
                    fixture,
                    expected,
                    previous
                );
                const row = {
                        observedAt: latest.observedAt,
                        ...assessed.cleanup,
                    },
                    signature = json({ ...row, observedAt: null });
                if (!changes.length || signature !== changes.at(-1).signature) {
                    need(
                        changes.length < CLEANUP_TRACE_LIMITS.changes,
                        'S3_OUTAGE_CLEANUP_TRACE_BOUND'
                    );
                    changes.push({ ...row, signature });
                }
                if (row.status === 'FAILED') break;
                await waitForNextSnapshot(
                    performance.now() + CLEANUP_TRACE_LIMITS.intervalMs,
                    deadline
                );
            }
            assessed = assessCleanupSnapshot(
                latest,
                phase,
                fixture,
                expected,
                previous
            );
            trace = {
                snapshots,
                changes: changes.map(
                    ({ signature: _signature, ...row }) => row
                ),
                ...validateCleanupTrace(changes),
                watchdogAckSha256: sha(ackBytes),
            };
        } else {
            latest = await snapshot();
            snapshots++;
            assessed = assessCleanupSnapshot(
                latest,
                phase,
                fixture,
                expected,
                previous
            );
        }
        let objectProof = { scope: 'NO_S3_SDK_CREATED', requests: 0 };
        if (phase !== 'cleanup-outage-failed') {
            const v = latest.versions[0],
                binding = {
                    documentId: v.documentId,
                    versionId: v.id,
                    version: 1,
                    sha256: expected.sha256,
                    byteSize: expected.bytes,
                    extractionPresent: true,
                    purged: assessed.purged,
                };
            objects = createReadOnlyObjectObserver({
                state,
                fixture,
                phase,
                bindings: [binding],
                admit: recheck,
            });
            for (const kind of assessed.purged
                ? ['original', 'artifact', 'structuredArtifact']
                : ['original', 'artifact']) {
                recheck();
                const descriptor = {
                    organizationId: fixture.organization.id,
                    documentId: v.documentId,
                    versionId: v.id,
                    kind,
                    location: latest.locations[0],
                    key: `${fixture.organization.id}/${v.documentId}/${v.id}/${kind === 'original' ? 'original' : kind === 'artifact' ? 'text.txt' : 'extraction.json'}`,
                    byteSize: expected.bytes,
                    expectedSha256: expected.sha256,
                };
                if (assessed.purged) await objects.absentPurged(descriptor);
                else
                    need(
                        (await objects.read(descriptor)).bytes.equals(text),
                        'S3_OUTAGE_CLEANUP_CANONICAL_BYTES'
                    );
            }
            objectProof = objects.summary();
            const after = await snapshot();
            need(
                metadataHash(after) === metadataHash(latest),
                'S3_OUTAGE_CLEANUP_POST_OBJECT_METADATA_CHANGED'
            );
        }
        recheck();
        need(
            !fs.existsSync(
                path.join(directory, 'watchdog-intervention.json')
            ) &&
                (!ackBytes ||
                    sha(
                        privateBytes(
                            path.join(directory, 'watchdog-ack.json'),
                            16384
                        )
                    ) === sha(ackBytes)),
            'S3_OUTAGE_CLEANUP_INTERVENTION'
        );
        const common = {
                schemaVersion: 1,
                ...assessed.source,
                observedAt: latest.observedAt,
            },
            process = {
                workerPid: state.processes.workers.pid,
                workerStartTicks: state.processes.workers.startTicks,
                rustfsContainerId: state.resources.rustfs.id,
            };
        const result = {
            ...receiptScope(state),
            namespace: state.namespace,
            phase,
            status: 'OBSERVED',
            fixtureSha256,
            ...assessed,
            objectProof,
            trace,
            metadataSha256: metadataHash(latest),
            counts: latest.counts,
            audits: latest.audits.map((row) => ({ action: row.action })),
            crossStoreConsistency:
                phase === 'cleanup-outage-failed'
                    ? 'DB_ONLY_NO_S3_READABILITY_OR_ABSENCE_CLAIM'
                    : 'METADATA_RECHECKED_NOT_CROSS_STORE_ATOMIC',
            browserAcceptance: 'NOT_DETERMINED',
            ...(phase === 'cleanup-ready'
                ? {
                      faultEnrollmentAdmission: {
                          ...common,
                          ...process,
                          kind: 'CLEANUP_READY_IDLE',
                          liveClaims: 0,
                      },
                  }
                : {}),
            ...(phase === 'cleanup-staged'
                ? {
                      faultAdmission: {
                          ...common,
                          ...process,
                          kind: 'CLEANUP_DELETE_ACCEPTED',
                          cleanupStatus: 'PENDING',
                          attempts: 0,
                          liveClaims: 0,
                          scheduledAt: latest.versions[0].cleanup.scheduledAt,
                      },
                  }
                : {}),
            ...(phase === 'cleanup-outage-failed'
                ? {
                      faultRecoveryAdmission: {
                          ...common,
                          kind: 'CLEANUP_FAILED',
                          attempts: 5,
                          status: 'FAILED',
                          errorCode: 'STORAGE_UNAVAILABLE',
                          scheduledAt: latest.versions[0].cleanup.scheduledAt,
                      },
                  }
                : {}),
        };
        objects?.close();
        objects = null;
        const activeClient = client;
        client = null;
        await activeClient.$disconnect();
        recheck();
        need(
            !fs.existsSync(path.join(directory, 'watchdog-intervention.json')),
            'S3_OUTAGE_CLEANUP_WATCHDOG_INTERVENED'
        );
        writePrivate(
            path.join(directory, `observe-${phase}.json`),
            JSON.parse(json(result))
        );
        console.log(
            json({
                ...receiptScope(state),
                completed: true,
                phase,
                status: 'OBSERVED',
                storageBytes: assessed.quota.storageBytes,
                snapshots,
            })
        );
    } catch (error) {
        try {
            writePrivate(
                path.join(directory, `observe-${phase}-incomplete.json`),
                {
                    ...receiptScope(state),
                    phase,
                    status: 'INCOMPLETE',
                    snapshots,
                    changes: changes.map(
                        ({ signature: _signature, ...row }) => row
                    ),
                }
            );
        } catch {
            /* Preserve original one-shot evidence. */
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
