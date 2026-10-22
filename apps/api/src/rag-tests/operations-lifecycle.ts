import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { parentText } from './parent-fixtures';
import {
    createOperationsFixture,
    operationCounts,
} from './operations-fixtures';
import {
    assertSyncDenied,
    assertSyncVersion,
    currentSyncTask,
    replaceSyncSource,
    scanSync,
    startSyncCollection,
    syncManageGrant,
} from './sync-authority-fixtures';

/** Operations discover exact current work; existing guarded mutations remain the only recovery authority. */
export async function operationsLifecycleTests(t: TestContext) {
    await t.test(
        'a real current index failure is discoverable and recovered through the existing retry while superseded historical failures stay excluded',
        async () => {
            const fixture = await createOperationsFixture(
                'Existing guarded index recovery'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Operations current failure',
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: true,
                        manageDocuments: false,
                        administer: true,
                    },
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nOperations recovery v2.`
                );
                const calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                const failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                const operations = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    state: 'FAILED',
                });
                assert.equal(operationCounts(operations, 'INDEXING').failed, 1);
                assert.equal(operations.visibleTotal, 1);
                assert.equal(operations.items[0]?.id, failed.id);
                assert.equal(
                    operations.items[0]?.target.id,
                    entry.collection.id
                );
                assert.equal(operations.items[0]?.target.type, 'COLLECTION');
                assert.equal(operations.items[0]?.version, null);
                assert.equal(operations.items[0]?.errorCode, 'ACCESS_REVOKED');
                assert.equal(
                    fixture.state.embedCalls,
                    calls,
                    'Reading Operations must not dispatch native work.'
                );
                assert.equal(
                    (
                        await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        )
                    ).status,
                    'FAILED'
                );
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                // The returned target opens the existing collection task screen; its
                // unchanged mutation performs the actual independent authorization.
                await f.manager.rag.indexing.retry({
                    collectionId: operations.items[0]!.target.id,
                    taskId: operations.items[0]!.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).authorityUserId,
                    f.users[0]
                );
                const recovered = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    state: 'FAILED',
                });
                assert.equal(operationCounts(recovered, 'INDEXING').failed, 0);
                assert.equal(recovered.visibleTotal, 0);

                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nOperations stale failure v3.`
                );
                await scanSync(fixture, [entry.generationId], 2);
                const stale = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(stale.status, 'FAILED');
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nOperations newer desired v4.`
                );
                const current = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.notEqual(current.id, stale.id);
                // Retained legacy failure metadata models an older worker's diagnostic.
                // No candidate, desired pointer, content, lease or completion is forged.
                await prisma.indexTask.update({
                    where: { id: stale.id },
                    data: { status: 'FAILED', errorCode: 'ACCESS_REVOKED' },
                });
                const snapshot = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert(snapshot.items.some((row) => row.id === current.id));
                assert.equal(
                    snapshot.items.some((row) => row.id === stale.id),
                    false
                );
                assert.equal(operationCounts(snapshot, 'INDEXING').failed, 0);
                await assertSyncDenied(
                    f.manager.rag.indexing.retry({
                        collectionId: entry.collection.id,
                        taskId: stale.id,
                    }),
                    ['CONFLICT']
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                });
                await f.owner.rag.documents.setCollection({
                    id: entry.documentId,
                    collectionId: entry.collection.id,
                    attached: false,
                });
                const detached = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert.equal(
                    detached.items.some((row) => row.id === current.id),
                    false
                );
                assert(
                    detached.items.some((row) => row.kind === 'REMOVE_DOCUMENT')
                );
                await assertSyncDenied(
                    f.manager.rag.indexing.retry({
                        collectionId: entry.collection.id,
                        taskId: current.id,
                    }),
                    ['CONFLICT']
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'accepted removal without a candidate and deleted document or collection cleanup retain separate current permissions and schedules',
        async () => {
            const fixture = await createOperationsFixture(
                'Deleted and retained work'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Deleted operations collection',
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.documents.setCollection({
                    id: entry.documentId,
                    collectionId: entry.collection.id,
                    attached: false,
                });
                const removal = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        generationId: entry.generationId,
                        kind: 'REMOVE_DOCUMENT',
                        status: 'PENDING',
                    },
                });
                assert.equal(removal.indexedDocumentId, null);
                const live = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert(
                    live.items.some(
                        (row) =>
                            row.id === removal.id &&
                            row.kind === 'REMOVE_DOCUMENT' &&
                            !row.target.deleted
                    )
                );
                await f.owner.rag.collections.delete({
                    id: entry.collection.id,
                    expectedRevision: 1,
                });
                const deleted = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert(
                    deleted.items.some(
                        (row) =>
                            row.kind === 'CLEAN_GENERATION' &&
                            row.target.deleted &&
                            row.target.id === entry.collection.id
                    )
                );
                assert(
                    deleted.items.every(
                        (row) =>
                            row.target.type === 'COLLECTION' &&
                            row.target.deleted
                    )
                );
                const hidden = await f.reader.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert.equal(hidden.visibleTotal, 0);
                assert.equal(
                    operationCounts(hidden, 'INDEXING').total,
                    operationCounts(deleted, 'INDEXING').total
                );
                const latest = await prisma.documentVersion.findFirstOrThrow({
                    where: {
                        organizationId: f.org,
                        documentId: entry.documentId,
                    },
                    orderBy: { version: 'desc' },
                });
                await f.owner.rag.documents.delete({
                    id: entry.documentId,
                    expectedVersionId: latest.id,
                    retentionDays: 1,
                });
                const cleanup = await f.reader.rag.operations.overview({
                    category: 'DOCUMENT_CLEANUP',
                    limit: 100,
                });
                assert.equal(cleanup.visibleTotal, 1);
                assert.equal(cleanup.items[0]?.id, latest.id);
                assert.equal(cleanup.items[0]?.state, 'SCHEDULED');
                assert.equal(cleanup.items[0]?.target.type, 'DOCUMENT');
                assert.equal(cleanup.items[0]?.target.id, entry.documentId);
                assert.equal(cleanup.items[0]?.target.deleted, true);
                assert(cleanup.items[0]!.availableAt > cleanup.observedAt);
                const collectionManager =
                    await f.manager.rag.operations.overview({
                        category: 'DOCUMENT_CLEANUP',
                    });
                assert.equal(
                    operationCounts(collectionManager, 'DOCUMENT_CLEANUP')
                        .total,
                    1
                );
                assert.equal(collectionManager.visibleTotal, 0);
                assert.equal(
                    operationCounts(
                        await f.owner.rag.operations.overview({
                            category: 'INGESTION',
                        }),
                        'INGESTION'
                    ).total,
                    0
                );
                const beforeCleanup =
                    await prisma.documentCleanup.findUniqueOrThrow({
                        where: { versionId: latest.id },
                    });
                assert.equal(beforeCleanup.status, 'PENDING');
                assert.equal(
                    (
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: latest.id },
                        })
                    ).discardedAt,
                    null
                );
                await f.owner.post('organization/remove-member', {
                    organizationId: f.org,
                    memberIdOrEmail: f.managerMember,
                });
                await assertSyncDenied(f.manager.rag.operations.overview({}), [
                    'UNAUTHORIZED',
                    'FORBIDDEN',
                ]);
                const retained = await prisma.documentCleanup.findUniqueOrThrow(
                    { where: { versionId: latest.id } }
                );
                assert.equal(retained.status, 'PENDING');
                assert.equal(
                    retained.availableAt.getTime(),
                    beforeCleanup.availableAt.getTime()
                );
                assert.equal(
                    retained.scheduledAt.getTime(),
                    beforeCleanup.scheduledAt.getTime()
                );
            } finally {
                await fixture.close();
            }
        }
    );
}
