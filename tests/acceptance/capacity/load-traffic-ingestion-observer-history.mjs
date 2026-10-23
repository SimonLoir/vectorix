/** Pure current/history validation for at most six artificial traffic documents. */
import { need, INGESTION_LIMITS } from './load-traffic-ingestion-observer.mjs';
import { same, sha, digest, id, decimal } from './load-observer-core.mjs';
import { validateDocumentLayout } from './load-observer-layout.mjs';

/** Validate all observed rows, including partial and cleaned superseded candidates; never fake a publication. */
export function validateIngestionInventory({
    input,
    generation,
    candidates,
    desired,
    associations,
    tasks,
    rows,
    physical,
    ledgers,
    plans,
    dependencies,
    identity,
}) {
    need(
        candidates.length <= INGESTION_LIMITS.candidates &&
            rows.length <= INGESTION_LIMITS.chunks &&
            physical.length <= INGESTION_LIMITS.chunks &&
            ledgers.length <= INGESTION_LIMITS.candidates &&
            tasks.length <= 256,
        'LOAD_INGEST_BOUNDS'
    );
    need(
        desired.length === input.bindings.length &&
            associations.length === desired.length &&
            new Set(candidates.map((value) => value.id)).size ===
                candidates.length &&
            new Set(rows.map((value) => value.id)).size === rows.length &&
            new Set(physical.map((value) => value.chunk_id)).size ===
                physical.length &&
            new Set(ledgers.map((value) => value.id)).size === ledgers.length,
        'LOAD_INGEST_INVENTORY'
    );
    const currentIds = new Set(
        desired.map((value) => value.publishedIndexedDocumentId)
    );
    need(
        currentIds.size === desired.length && [...currentIds].every(id),
        'LOAD_INGEST_CURRENT'
    );
    const summaries = [];
    let active = 0n,
        retained = 0n,
        retainedPhysical = 0,
        partial = 0;
    const states = { PUBLISHED: 0, RETIRED: 0, CLEANING: 0, CLEANED: 0 };
    for (const candidate of candidates) {
        const index = input.bindings.findIndex(
                (value) => value.documentId === candidate.documentId
            ),
            binding = input.bindings[index],
            descriptor = input.descriptors[index],
            planned = plans[index];
        need(
            index >= 0 &&
                candidate.organizationId === input.organizationId &&
                candidate.generationId === input.generationId &&
                candidate.sourceVersionId === binding.versionId &&
                candidate.version === 1 &&
                candidate.sha256 === descriptor.originalSha256 &&
                candidate.fileName === descriptor.fileName &&
                candidate.mediaType === 'text/plain' &&
                candidate.extractorVersion === 'utf8-text-v1' &&
                candidate.sourceState === 'AVAILABLE' &&
                candidate.sourceStatus === 'READY' &&
                candidate.ingestionStatus === 'READY' &&
                candidate.ingestionReservedBytes === '0' &&
                candidate.discardedAt === null &&
                candidate.extractionDiscardedAt === null,
            'LOAD_INGEST_SOURCE'
        );
        need(
            planned.children.length === 1 &&
                planned.parents.length === 1 &&
                sha(planned.artifact.text) === descriptor.canonicalSha256,
            'LOAD_INGEST_PLAN'
        );
        const appRows = rows
                .filter((value) => value.indexedDocumentId === candidate.id)
                .sort((a, b) => a.ordinal - b.ordinal),
            vectorRows = physical
                .filter((value) => value.publication_id === candidate.id)
                .sort((a, b) => a.ordinal - b.ordinal),
            ledger = ledgers.find((value) => value.id === candidate.id);
        need(
            Object.hasOwn(states, candidate.status) &&
                Number.isInteger(candidate.materializedChunks) &&
                candidate.materializedChunks >= 0 &&
                candidate.materializedChunks <= 1 &&
                Number.isInteger(candidate.chunkCount) &&
                candidate.chunkCount >= candidate.materializedChunks &&
                candidate.chunkCount <= 1,
            'LOAD_INGEST_HISTORY'
        );
        states[candidate.status]++;
        if (currentIds.has(candidate.id)) {
            const target = desired.find(
                    (value) => value.documentId === candidate.documentId
                ),
                association = associations.find(
                    (value) => value.documentId === candidate.documentId
                );
            need(
                target &&
                    association &&
                    target.removedAt === null &&
                    target.desiredVersionId === candidate.sourceVersionId &&
                    target.desiredExtractionId === candidate.extractionId &&
                    target.desiredMetadataRevision ===
                        candidate.metadataRevision &&
                    target.buildRevision === candidate.buildRevision &&
                    target.desiredChangeSequence ===
                        candidate.sourceChangeSequence &&
                    target.targetChunkCount === 1 &&
                    association.metadataRevision === 2 &&
                    same(candidate.metadata, descriptor.metadata) &&
                    same(candidate.tags, descriptor.tags) &&
                    candidate.language === descriptor.language &&
                    same(association.metadata, descriptor.metadata) &&
                    same(association.tags, descriptor.tags) &&
                    association.language === descriptor.language,
                'LOAD_INGEST_CURRENT'
            );
            validateDocumentLayout({
                candidate,
                descriptor,
                ...planned,
                rows: appRows,
                physical: vectorRows,
                ledger,
                prepare: dependencies.prepare,
                manifestHash: dependencies.manifestHash,
                identity,
            });
            active += BigInt(candidate.materializedChunks);
        } else {
            need(candidate.status !== 'PUBLISHED', 'LOAD_INGEST_UNPOINTED');
            if (candidate.status === 'CLEANED')
                need(
                    appRows.length === 0 &&
                        vectorRows.length === 0 &&
                        candidate.materializedChunks === 0 &&
                        candidate.holdState === 'RELEASED' &&
                        (!ledger || ledger.state === 'TOMBSTONED'),
                    'LOAD_INGEST_CLEANED'
                );
            else {
                need(
                    candidate.holdState === 'RETIRED' &&
                        appRows.filter((value) => value.kind === 'CHILD')
                            .length === candidate.materializedChunks,
                    'LOAD_INGEST_HISTORY'
                );
                const expected = [...planned.children, ...planned.parents];
                for (const row of appRows) {
                    const plan = expected[row.ordinal],
                        child = row.ordinal === 0;
                    need(
                        plan &&
                            row.organizationId === input.organizationId &&
                            row.generationId === input.generationId &&
                            row.kind === (child ? 'CHILD' : 'PARENT') &&
                            row.text === plan.text &&
                            row.startOffset === plan.start &&
                            row.endOffset === plan.end &&
                            row.text ===
                                planned.artifact.text.slice(
                                    row.startOffset,
                                    row.endOffset
                                ) &&
                            row.textHash === sha(plan.text) &&
                            row.tokenCount === plan.tokenCount &&
                            row.tokenCountIsEstimate === true &&
                            same(row.sourceSpans, plan.sourceSpans) &&
                            row.sourceSpanCount === plan.sourceSpans.length &&
                            row.sourceSpanCount <= 64,
                        'LOAD_INGEST_HISTORY_LAYOUT'
                    );
                    need(
                        child
                            ? row.embeddingInputHash ===
                                  sha(
                                      dependencies.prepare(
                                          identity,
                                          'document',
                                          plan.text,
                                          {
                                              title: candidate.fileName,
                                              preparation: '',
                                          }
                                      )
                                  ) &&
                                  row.parentId ===
                                      appRows.find(
                                          (value) =>
                                              value.ordinal ===
                                              planned.mapping[0]
                                      )?.id
                            : row.embeddingInputHash === null &&
                                  row.parentId === null,
                        'LOAD_INGEST_HISTORY_LAYOUT'
                    );
                }
                need(
                    vectorRows.length <= candidate.materializedChunks &&
                        (!vectorRows.length ||
                            (ledger &&
                                ['OPEN', 'SEALED'].includes(ledger.state))),
                    'LOAD_INGEST_HISTORY_VECTOR'
                );
                for (const row of vectorRows) {
                    const chunk = appRows.find(
                        (value) =>
                            value.kind === 'CHILD' && value.id === row.chunk_id
                    );
                    need(
                        chunk &&
                            row.ordinal === chunk.ordinal &&
                            row.chunk_hash === chunk.textHash &&
                            row.document_id === candidate.documentId &&
                            row.source_version_id ===
                                candidate.sourceVersionId &&
                            row.generation_id === input.generationId &&
                            row.dimensions === 768 &&
                            row.finite_nonzero === true,
                        'LOAD_INGEST_HISTORY_VECTOR'
                    );
                }
                if (appRows.length !== 2) partial++;
                retained += BigInt(candidate.materializedChunks);
                retainedPhysical += vectorRows.length;
            }
        }
        if (ledger) {
            need(
                ledger.document_id === candidate.documentId &&
                    ledger.source_version_id === candidate.sourceVersionId &&
                    ledger.expected_count === 1 &&
                    ['OPEN', 'SEALED', 'TOMBSTONED'].includes(ledger.state),
                'LOAD_INGEST_LEDGER'
            );
            if (candidate.status !== 'CLEANED')
                need(
                    appRows.length === 2 &&
                        appRows.filter((value) => value.kind === 'CHILD')
                            .length === 1 &&
                        ledger.manifest_hash ===
                            dependencies.manifestHash(
                                appRows
                                    .filter((value) => value.kind === 'CHILD')
                                    .map((value) => ({
                                        chunkId: value.id,
                                        ordinal: value.ordinal,
                                        chunkHash: value.textHash,
                                    }))
                            ),
                    'LOAD_INGEST_LEDGER'
                );
            if (ledger.state === 'SEALED')
                need(
                    appRows.filter((value) => value.kind === 'CHILD').length ===
                        1 &&
                        vectorRows.length === 1 &&
                        ledger.manifest_hash ===
                            dependencies.manifestHash(
                                appRows
                                    .filter((value) => value.kind === 'CHILD')
                                    .map((value) => ({
                                        chunkId: value.id,
                                        ordinal: value.ordinal,
                                        chunkHash: value.textHash,
                                    }))
                            ),
                    'LOAD_INGEST_LEDGER'
                );
            if (candidate.manifestHash !== null)
                need(
                    ledger.manifest_hash === candidate.manifestHash,
                    'LOAD_INGEST_LEDGER'
                );
        }
        summaries.push([
            candidate.id,
            candidate.documentId,
            candidate.status,
            candidate.materializedChunks,
            candidate.chunkCount,
            appRows.map((value) => [
                value.id,
                value.ordinal,
                value.textHash,
                value.embeddingInputHash,
                value.parentId,
            ]),
            vectorRows.map((value) => [
                value.chunk_id,
                value.ordinal,
                value.chunk_hash,
            ]),
            ledger?.state ?? null,
        ]);
    }
    need(
        [...currentIds].every((value) =>
            candidates.some((row) => row.id === value)
        ) &&
            rows.every((row) =>
                candidates.some((value) => value.id === row.indexedDocumentId)
            ) &&
            physical.every((row) =>
                candidates.some((value) => value.id === row.publication_id)
            ) &&
            ledgers.every((row) =>
                candidates.some((value) => value.id === row.id)
            ),
        'LOAD_INGEST_ORPHAN'
    );
    let reserved = 0n,
        observedIndexAttempts = 0,
        observedAdditionalIndexAttempts = 0,
        observedIndexContinuations = 0,
        indexTasksWithErrorCode = 0,
        indexCancelledTasks = 0,
        failedOutstandingCleanupTasks = 0;
    const cleanup = { pending: 0, processing: 0, failed: 0 };
    for (const task of tasks) {
        need(
            task.organizationId === input.organizationId &&
                task.generationId === input.generationId &&
                Number.isInteger(task.reservedChunks) &&
                task.reservedChunks >= 0 &&
                task.reservedChunks <= 1 &&
                [task.attempts, task.continuations].every(
                    (value) =>
                        Number.isSafeInteger(value) &&
                        value >= 0 &&
                        value <= 1000
                ) &&
                (task.errorCode === null ||
                    (typeof task.errorCode === 'string' &&
                        task.errorCode.length <= 100)),
            'LOAD_INGEST_TASK'
        );
        if (task.kind === 'INDEX_DOCUMENT') {
            const candidate = candidates.find(
                (value) => value.id === task.indexedDocumentId
            );
            need(
                candidate &&
                    ['COMPLETE', 'CANCELLED'].includes(task.status) &&
                    (candidate.status !== 'CLEANED' ||
                        task.reservedChunks === 0) &&
                    (task.status !== 'COMPLETE' || task.reservedChunks === 0),
                'LOAD_INGEST_TASK'
            );
            reserved += BigInt(task.reservedChunks);
            observedIndexAttempts += task.attempts;
            observedAdditionalIndexAttempts += Math.max(0, task.attempts - 1);
            observedIndexContinuations += task.continuations;
            indexTasksWithErrorCode += Number(task.errorCode !== null);
            indexCancelledTasks += Number(task.status === 'CANCELLED');
        } else if (task.kind === 'CLEAN_PUBLICATION') {
            const candidate = candidates.find(
                (value) => value.id === task.indexedDocumentId
            );
            need(
                candidate &&
                    !currentIds.has(candidate.id) &&
                    task.reservedChunks === 0,
                'LOAD_INGEST_TASK'
            );
            const key = {
                PENDING: 'pending',
                PROCESSING: 'processing',
                FAILED: 'failed',
            }[task.status];
            if (key) cleanup[key]++;
            if (task.status === 'FAILED' && candidate.status !== 'CLEANED')
                failedOutstandingCleanupTasks++;
        } else
            need(
                task.kind === 'PROVISION' &&
                    task.status === 'COMPLETE' &&
                    task.reservedChunks === 0,
                'LOAD_INGEST_TASK'
            );
    }
    need(
        candidates.every((candidate) =>
            tasks.some(
                (task) =>
                    task.kind === 'INDEX_DOCUMENT' &&
                    task.indexedDocumentId === candidate.id
            )
        ) &&
            [...currentIds].every((candidateId) =>
                tasks.some(
                    (task) =>
                        task.kind === 'INDEX_DOCUMENT' &&
                        task.indexedDocumentId === candidateId &&
                        task.status === 'COMPLETE' &&
                        task.reservedChunks === 0
                )
            ),
        'LOAD_INGEST_TASK'
    );
    need(
        active === BigInt(input.bindings.length) &&
            decimal(generation.activeChunks) === active &&
            decimal(generation.retainedChunks) === retained &&
            decimal(generation.reservedChunks) === reserved &&
            generation.projectedChunks === String(active),
        'LOAD_INGEST_ACCOUNTING'
    );
    return {
        currentDocuments: input.bindings.length,
        newPublishedDocuments: 3,
        newPublishedChildren: 3,
        sourceTuplesVerified: true,
        canonicalLayoutVerified: true,
        physicalManifestsVerified: true,
        accountingVerified: true,
        noCurrentFailures: true,
        cleanupHealth: failedOutstandingCleanupTasks
            ? 'UNRESOLVED_FAILED_CLEANUP'
            : 'CLEAN',
        failedOutstandingCleanupTasks,
        retained: {
            candidates: candidates.length - currentIds.size,
            children: Number(retained),
            physicalChildren: retainedPhysical,
        },
        accounting: {
            activeChildren: active.toString(),
            retainedChildren: retained.toString(),
            reservedChildren: reserved.toString(),
        },
        history: {
            candidateStates: states,
            cleanupPendingTasks: cleanup.pending,
            cleanupProcessingTasks: cleanup.processing,
            cleanupFailedTasks: cleanup.failed,
            partialLayoutCandidates: partial,
            observedIndexAttempts,
            observedAdditionalIndexAttempts,
            observedIndexContinuations,
            indexTasksWithErrorCode,
            indexCancelledTasks,
            retryHistory: 'CURRENT_STORED_TASK_COUNTERS_NOT_LIFETIME_OR_WIRE',
        },
        manifestSha256: digest(summaries),
    };
}
