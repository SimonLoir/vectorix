/** Pure closed-scenario validation; no filesystem, database, provider or process I/O. */
import { need } from './private.mjs';
import { PROFILE, MODEL_DIGEST } from './vector-embedding.mjs';
import { sha, id } from './vector-workflow.mjs';
export const VECTOR_PHASES = Object.freeze([
    'vector-g1-ready',
    'vector-g2-staged',
    'vector-outage-failed',
    'vector-restored-before-retry',
    'vector-g2-ready',
    'vector-signed-out',
]);
const normalize = (item) =>
    item instanceof Date
        ? item.toISOString()
        : typeof item === 'bigint'
          ? item.toString()
          : Array.isArray(item)
            ? item.map(normalize)
            : item && typeof item === 'object'
              ? Object.fromEntries(
                    Object.keys(item)
                        .sort()
                        .map((key) => [key, normalize(item[key])])
                )
              : item;
export const canonical = (value) => JSON.stringify(normalize(value));
const same = (a, b) => canonical(a) === canonical(b);
const at = (value) =>
    value instanceof Date
        ? value.getTime()
        : typeof value === 'string' && /(?:Z|\+00:00)$/u.test(value)
          ? Date.parse(value)
          : NaN;
export const failure = (value, label) =>
    need(value, 'S3_OUTAGE_VECTOR_' + label);
/** Assert the exact original profile without adopting organization credentials or a new vector destination. */
export function assertVectorProfile(configuration, state) {
    failure(
        configuration &&
            Object.entries(PROFILE).every(([key, value]) =>
                same(configuration[key], value)
            ) &&
            configuration.credentialId === null &&
            configuration.credentialRevision === null &&
            configuration.endpoint ===
                state.environment.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
        'SAVED_PROFILE'
    );
}
/** Replan using the pinned production chunker after context admission, without provider calls. */
/** Require coherent source/layout/accounting and preserve G1 until the complete G2 activation. */
export function assessVectorSnapshot(
    value,
    phase,
    fixture,
    binding,
    state,
    layout
) {
    failure(
        VECTOR_PHASES.includes(phase) || phase === 'vector-progress',
        'PHASE'
    );
    const hasG2 = phase !== 'vector-g1-ready',
        completed = ['vector-g2-ready', 'vector-signed-out'].includes(phase),
        generations = [binding.g1, ...(hasG2 ? [binding.g2] : [])],
        children = layout.children.length;
    failure(
        generations.every(id) &&
            new Set(generations).size === generations.length &&
            value.generations.length === generations.length &&
            value.candidates.length === generations.length &&
            value.desired.length === generations.length &&
            value.holds.length === generations.length,
        'INVENTORY'
    );
    failure(
        value.collection?.activeGenerationId ===
            (completed ? binding.g2 : binding.g1) &&
            value.collection.configurationRevision === 1 &&
            !value.collection.deletedAt &&
            value.collection.id === binding.collectionId &&
            value.collection.organizationId === fixture.organization.id,
        'ACTIVE_POINTER'
    );
    for (const [name, count] of Object.entries({
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
    }))
        failure(value.counts[name] === count, 'COUNTS');
    failure(
        Number.isInteger(value.counts.sessions) &&
            value.counts.sessions <= 2 &&
            (phase !== 'vector-signed-out' || value.counts.sessions === 0) &&
            value.user?.id === fixture.users.owner.userId &&
            value.user.email === fixture.users.owner.email &&
            value.user.emailVerified === false &&
            value.user.isSuperAdmin === false &&
            value.organization?.isActive === true &&
            same(value.members, fixture.membershipSnapshot),
        'IDENTITY'
    );
    failure(
        value.quota?.originalBytes ===
            String(state.inputs.textFixtures['s3-outage-v1.txt'].bytes) &&
            value.quota.extractionBytes === value.quota.originalBytes &&
            value.quota.reservedBytes === '0',
        'SOURCE_STORAGE_ACCOUNTING'
    );
    failure(
        value.version?.id === binding.versionId &&
            value.version.status === 'READY' &&
            value.version.contentState === 'AVAILABLE' &&
            value.version.discardedAt === null &&
            value.version.sha256 === binding.originalSha256 &&
            Number(value.version.byteSize) ===
                state.inputs.textFixtures['s3-outage-v1.txt'].bytes &&
            value.extraction?.discardedAt === null &&
            value.extraction.extractorVersion === 'utf8-text-v1' &&
            Number(value.extraction.byteSize) ===
                Number(value.version.byteSize),
        'SOURCE'
    );
    failure(
        value.tasks.length === value.taskCount &&
            value.tasks.length <= 5 &&
            value.chunks.length <= 32 &&
            value.liveClaims === 0,
        'TASK_BOUND_OR_LIVE_CLAIM'
    );
    const cleanup = value.tasks.filter(
        (task) => task.kind === 'CLEAN_GENERATION'
    );
    const costTasks = value.tasks.filter((task) =>
        ['PROVISION', 'INDEX_DOCUMENT'].includes(task.kind)
    );
    failure(
        costTasks.length === generations.length * 2 &&
            value.tasks.length === costTasks.length + (completed ? 1 : 0) &&
            cleanup.length === (completed ? 1 : 0),
        'EXACT_TASK_INVENTORY'
    );
    if (completed) {
        const old = value.generations.find((row) => row.id === binding.g1);
        const active = value.generations.find((row) => row.id === binding.g2);
        const task = cleanup[0];
        const hold = value.holds.find(
            (row) =>
                row.indexedDocumentId ===
                value.candidates.find(
                    (candidate) => candidate.generationId === binding.g1
                )?.id
        );
        failure(
            Number.isSafeInteger(layout.sourceRetireGraceMs) &&
                layout.sourceRetireGraceMs > 0 &&
                Number.isFinite(at(old?.retiredAt)) &&
                at(active?.activatedAt) === at(old.retiredAt) &&
                at(old.cleanupAfter) ===
                    at(old.retiredAt) + layout.sourceRetireGraceMs &&
                at(hold?.retainUntil) === at(old.cleanupAfter) &&
                at(task.availableAt) === at(old.cleanupAfter) &&
                at(old.cleanupAfter) > at(value.observedAt),
            'NATIVE_RETENTION'
        );
        failure(
            id(task.id) &&
                task.generationId === binding.g1 &&
                task.indexedDocumentId === null &&
                task.status === 'PENDING' &&
                task.stage === 'ACCEPTED' &&
                task.attempts === 0 &&
                BigInt(task.leaseEpoch) === 0n &&
                task.leasedUntil === null &&
                task.errorCode === null &&
                task.reservedChunks === 0 &&
                task.completedChunks === 0,
            'CLEANUP_TASK'
        );
    }
    let materialized = 0;
    const manifests = [];
    for (const generationId of generations) {
        const target = generationId === binding.g2,
            ready = !target || completed,
            generation = value.generations.find((g) => g.id === generationId),
            candidate = value.candidates.find(
                (p) => p.generationId === generationId
            ),
            desired = value.desired.find(
                (d) => d.generationId === generationId
            ),
            hold = value.holds.find(
                (h) => h.indexedDocumentId === candidate?.id
            );
        failure(
            generation &&
                generation.organizationId === fixture.organization.id &&
                generation.collectionId === binding.collectionId &&
                generation.previousGenerationId ===
                    (target ? binding.g1 : null) &&
                generation.configurationRevision === 1 &&
                generation.status ===
                    (target
                        ? completed
                            ? 'ACTIVE'
                            : 'PROVISIONING'
                        : completed
                          ? 'RETIRED'
                          : 'ACTIVE') &&
                generation.chunkerVersion === 'structure-utf8-v1' &&
                generation.parentContextVersion === 'parent-context-utf8-v1' &&
                generation.vectorSchema === 'vector_collections' &&
                generation.tableName ===
                    'g_' + generationId.replaceAll('-', '') &&
                generation.destinationFingerprint ===
                    value.generations.find((g) => g.id === binding.g1)
                        .destinationFingerprint &&
                BigInt(generation.projectedChunks) ===
                    BigInt(ready ? children : 0) &&
                (!ready ||
                    BigInt(generation.appliedSequence) ===
                        BigInt(value.collection.contentSequence)) &&
                generation.modelIdentity === MODEL_DIGEST &&
                generation.capabilitySnapshot?.digest === MODEL_DIGEST &&
                generation.capabilitySnapshot?.dimensions === 3,
            'GENERATION'
        );
        assertVectorProfile(generation.configuration, state);
        failure(
            candidate.documentId === binding.documentId &&
                candidate.sourceVersionId === binding.versionId &&
                candidate.extractionId === value.extraction.id &&
                candidate.status === (ready ? 'PUBLISHED' : 'STAGING') &&
                candidate.materializedChunks === (ready ? children : 0) &&
                candidate.chunkCount === (ready ? children : 0) &&
                desired.documentId === binding.documentId &&
                desired.desiredVersionId === binding.versionId &&
                desired.desiredExtractionId === value.extraction.id &&
                desired.removedAt === null &&
                desired.publishedIndexedDocumentId ===
                    (ready ? candidate.id : null),
            'CANDIDATE'
        );
        failure(
            hold.indexedDocumentId === candidate.id &&
                hold.versionId === binding.versionId &&
                hold.releasedAt === null &&
                hold.state === (!target && completed ? 'RETIRED' : 'LIVE') &&
                (!completed ||
                    target ||
                    at(hold.retainUntil) > at(value.observedAt)),
            'SOURCE_HOLD'
        );
        const rows = value.chunks
                .filter((row) => row.generationId === generationId)
                .sort((a, b) => a.ordinal - b.ordinal),
            expectedRows = [...layout.children, ...layout.parents].sort(
                (a, b) => a.ordinal - b.ordinal
            );
        failure(
            rows.length === (ready ? expectedRows.length : 0),
            'LAYOUT_COUNT'
        );
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i],
                expected = expectedRows[i],
                child = row.ordinal < children,
                parentOrdinal = layout.childParentOrdinals[row.ordinal];
            failure(
                row.indexedDocumentId === candidate.id &&
                    row.ordinal === expected.ordinal &&
                    row.kind === (child ? 'CHILD' : 'PARENT') &&
                    row.text === expected.text &&
                    row.textHash === sha(expected.text) &&
                    row.embeddingInputHash ===
                        (child ? sha(expected.text) : null) &&
                    row.startOffset === expected.start &&
                    row.endOffset === expected.end &&
                    row.sourceSpanCount <= 64 &&
                    same(row.sourceSpans, expected.sourceSpans) &&
                    row.parentId ===
                        (child
                            ? rows.find((p) => p.ordinal === parentOrdinal)?.id
                            : null),
                'CANONICAL_LAYOUT'
            );
        }
        const manifest = ready
            ? sha(
                  JSON.stringify(
                      rows
                          .filter((row) => row.kind === 'CHILD')
                          .map((row) => [row.id, row.ordinal, row.textHash])
                  )
              )
            : null;
        failure(
            candidate.manifestHash === manifest &&
                (ready
                    ? candidate.vectorSealedAt && candidate.publishedAt
                    : candidate.vectorSealedAt === null &&
                      candidate.publishedAt === null),
            'MANIFEST'
        );
        manifests.push({
            generationId,
            publicationId: candidate.id,
            sourceVersionId: binding.versionId,
            destinationFingerprint: generation.destinationFingerprint,
            manifestSha256: manifest,
            children: ready ? children : 0,
        });
        materialized += candidate.materializedChunks;
        const provision = value.tasks.find(
                (task) =>
                    task.generationId === generationId &&
                    task.kind === 'PROVISION'
            ),
            index = value.tasks.find(
                (task) =>
                    task.generationId === generationId &&
                    task.kind === 'INDEX_DOCUMENT'
            );
        failure(
            provision &&
                index &&
                value.tasks.filter(
                    (task) =>
                        task.generationId === generationId &&
                        task.kind === 'PROVISION'
                ).length === 1 &&
                value.tasks.filter(
                    (task) =>
                        task.generationId === generationId &&
                        task.kind === 'INDEX_DOCUMENT'
                ).length === 1 &&
                index.indexedDocumentId === candidate.id &&
                index.status === (ready ? 'COMPLETE' : 'PENDING') &&
                index.reservedChunks === 0 &&
                (ready || index.attempts === 0) &&
                provision.reservedChunks === 0 &&
                provision.leasedUntil === null,
            'TASK_STATE'
        );
        if (ready)
            failure(
                provision.status === 'COMPLETE' && provision.errorCode === null,
                'PROVISION_COMPLETE'
            );
        else if (phase === 'vector-g2-staged')
            failure(
                provision.status === 'PENDING' &&
                    provision.attempts === 0 &&
                    provision.errorCode === null,
                'UNCLAIMED_PROVISION'
            );
        else if (
            ['vector-outage-failed', 'vector-restored-before-retry'].includes(
                phase
            )
        )
            failure(
                provision.status === 'FAILED' &&
                    provision.attempts === 5 &&
                    provision.errorCode === 'VECTOR_UNAVAILABLE',
                'FAILED_PROVISION'
            );
        else
            failure(
                (provision.status === 'PENDING' &&
                    provision.attempts >= 1 &&
                    provision.attempts <= 4 &&
                    provision.errorCode === 'VECTOR_UNAVAILABLE') ||
                    (provision.status === 'FAILED' &&
                        provision.attempts === 5 &&
                        provision.errorCode === 'VECTOR_UNAVAILABLE'),
                'RETRY_PROGRESS'
            );
    }
    failure(
        BigInt(value.usage.activeChunks) === BigInt(children) &&
            BigInt(value.usage.retainedChunks) ===
                BigInt(materialized - children) &&
            BigInt(value.usage.reservedChunks) === 0n,
        'ACCOUNTING'
    );
    const provision = value.tasks.find(
        (task) => task.generationId === binding.g2 && task.kind === 'PROVISION'
    );
    return {
        activeGenerationId: value.collection.activeGenerationId,
        manifests,
        usage: value.usage,
        sourceStorage: value.quota,
        provision: provision
            ? {
                  id: provision.id,
                  status: provision.status,
                  attempts: provision.attempts,
                  leaseEpoch: provision.leaseEpoch,
                  errorCode: provision.errorCode,
                  availableAt: provision.availableAt,
                  updatedAt: provision.updatedAt,
                  leasedUntil: provision.leasedUntil,
              }
            : null,
    };
}
/** Bind later observations to the first sealed G1 and the same fenced G2 provision task. */
export function assertVectorContinuity({
    phase,
    binding,
    assessment,
    physical,
    baseline,
    previous,
}) {
    if (phase === 'vector-g1-ready') {
        failure(baseline === null && previous === null, 'BASELINE_CONTINUITY');
        return;
    }
    const baselineManifest = baseline?.manifests?.find(
            (row) => row.generationId === binding.g1
        ),
        currentManifest = assessment.manifests.find(
            (row) => row.generationId === binding.g1
        );
    failure(
        baselineManifest &&
            currentManifest &&
            same(baselineManifest, currentManifest),
        'G1_MANIFEST_CONTINUITY'
    );
    if (phase !== 'vector-outage-failed') {
        const oldPhysical = baseline.physical?.generations?.find(
                (row) => row.generationId === binding.g1
            ),
            currentPhysical = physical.generations?.find(
                (row) => row.generationId === binding.g1
            );
        failure(
            physical.identitySha256 === baseline.physical?.identitySha256 &&
                oldPhysical?.provisioned === true &&
                currentPhysical?.provisioned === true &&
                same(oldPhysical, currentPhysical),
            'G1_PHYSICAL_CONTINUITY'
        );
    }
    const current = assessment.provision;
    failure(
        current && /^\d+$/u.test(String(current.leaseEpoch)),
        'TASK_CONTINUITY'
    );
    if (phase === 'vector-g2-staged') return;
    const prior = previous?.provision;
    failure(
        prior &&
            current.id === prior.id &&
            /^\d+$/u.test(String(prior.leaseEpoch)),
        'TASK_CONTINUITY'
    );
    const epoch = BigInt(current.leaseEpoch),
        oldEpoch = BigInt(prior.leaseEpoch);
    if (phase === 'vector-outage-failed' || phase === 'vector-g2-ready')
        failure(epoch > oldEpoch, 'TASK_EPOCH_CONTINUITY');
    else failure(epoch === oldEpoch, 'TASK_EPOCH_CONTINUITY');
}
/** Keep only the closed durable failure schedule; arbitrary task or provider fields never reach receipts. */
export function vectorTraceRow(input) {
    const fields = [
        'id',
        'status',
        'attempts',
        'leaseEpoch',
        'errorCode',
        'availableAt',
        'updatedAt',
        'leasedUntil',
    ];
    failure(
        input &&
            Object.keys(input).sort().join(',') ===
                [...fields].sort().join(','),
        'TRACE_ROW'
    );
    failure(
        id(input.id) &&
            ['PENDING', 'FAILED'].includes(input.status) &&
            Number.isSafeInteger(input.attempts) &&
            input.attempts >= 1 &&
            input.attempts <= 5 &&
            input.errorCode === 'VECTOR_UNAVAILABLE' &&
            input.leasedUntil === null,
        'TRACE_ROW'
    );
    const epoch =
        typeof input.leaseEpoch === 'bigint'
            ? input.leaseEpoch.toString()
            : input.leaseEpoch;
    failure(
        typeof epoch === 'string' && /^\d{1,20}$/u.test(epoch),
        'TRACE_ROW'
    );
    const dates = {};
    for (const field of ['availableAt', 'updatedAt']) {
        const milliseconds = at(input[field]);
        failure(Number.isFinite(milliseconds), 'TRACE_ROW');
        dates[field] = new Date(milliseconds).toISOString();
    }
    return {
        id: input.id,
        status: input.status,
        attempts: input.attempts,
        leaseEpoch: epoch,
        errorCode: input.errorCode,
        ...dates,
        leasedUntil: null,
    };
}
/** Preserve up to eleven changes and a separate twelfth event without increasing the admitted trace bound. */
export function createVectorTraceCollector() {
    const changes = [];
    let overflow = null;
    return {
        record(input) {
            const row = vectorTraceRow(input);
            if (changes.length && same(row, changes.at(-1))) return;
            if (changes.length === 11) {
                overflow = row;
                failure(false, 'COLLECT_BOUND');
            }
            changes.push(row);
        },
        evidence() {
            return {
                changes: changes.map(vectorTraceRow),
                overflow: overflow && vectorTraceRow(overflow),
            };
        },
        validate() {
            return validateVectorTrace(changes);
        },
    };
}
/** Require all four observed natural backoffs; neither an observed task nor a stage label is an I/O count. */
export function validateVectorTrace(changes) {
    failure(changes.length <= 11, 'COLLECT_BOUND');
    failure(changes.length >= 5, 'INCOMPLETE_TRACE');
    for (let attempt = 1; attempt <= 5; attempt++) {
        const row = changes.find(
            (item) =>
                item.attempts === attempt &&
                item.status === (attempt === 5 ? 'FAILED' : 'PENDING')
        );
        failure(
            row &&
                row.errorCode === 'VECTOR_UNAVAILABLE' &&
                row.leasedUntil === null &&
                Number.isFinite(at(row.updatedAt)) &&
                Number.isFinite(at(row.availableAt)),
            'TRACE_ATTEMPT'
        );
        failure(/^\d+$/u.test(String(row.leaseEpoch)), 'TRACE_EPOCH');
        if (attempt < 5) {
            const next = changes.find((item) => item.attempts === attempt + 1);
            failure(
                Math.abs(
                    at(row.availableAt) -
                        at(row.updatedAt) -
                        5000 * 2 ** attempt
                ) <= 5 &&
                    next &&
                    BigInt(next.leaseEpoch) > BigInt(row.leaseEpoch) &&
                    at(next.updatedAt) >= at(row.availableAt),
                'NATURAL_BACKOFF'
            );
        }
    }
    failure(
        at(changes.find((r) => r.attempts === 5).updatedAt) -
            at(changes.find((r) => r.attempts === 1).updatedAt) >=
            150000,
        'TRACE_DURATION'
    );
    return {
        attempts: 5,
        backoffMilliseconds: [10000, 20000, 40000, 80000],
        semantics: 'DURABLE_PROVISION_CLAIMS_NOT_WIRE_COUNT',
    };
}
