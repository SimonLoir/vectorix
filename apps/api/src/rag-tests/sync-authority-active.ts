import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { parentProfile, parentText } from './parent-fixtures';
import {
    assertSyncDenied,
    assertSyncVersion,
    createSyncFixture,
    currentSyncTask,
    replaceSyncSource,
    scanSync,
    startSyncCollection,
    syncManageGrant,
    waitSyncActive,
} from './sync-authority-fixtures';

/** Current explicit generation controllers execute library events without granting the writer collection privileges. */
export async function syncAuthorityActiveTests(t: TestContext) {
    const fixture = await createSyncFixture('Active and initial dispatch');
    try {
        await t.test(
            'a library-only writer updates two ACTIVE collections under independent current controllers',
            async () => {
                const first = await startSyncCollection(fixture, {
                    name: 'Shared controller A',
                });
                const second = await startSyncCollection(fixture, {
                    name: 'Shared controller B',
                    strategy: 'SEMANTIC',
                    controller: 'manager',
                    documentId: first.documentId,
                });
                const query = {
                    collectionId: first.collection.id,
                    query: 'forest',
                    strategy: 'HYBRID' as const,
                    topK: 5,
                    filters: {},
                };
                const before = await f.owner.rag.indexing.search(query);
                assert(before.results[0]?.parentContext);
                const receipt = before.results[0].source.receipt;
                const nextText = `${parentText}\nShared v2 forest marker.`;
                const version = await replaceSyncSource(
                    fixture,
                    first.documentId,
                    nextText
                );
                const a = await currentSyncTask(
                    first.generationId,
                    first.documentId
                );
                const b = await currentSyncTask(
                    second.generationId,
                    first.documentId
                );
                assert.equal(a.requestedBy, f.users[0]);
                assert.equal(b.requestedBy, f.users[3]);
                assert.notEqual(a.requestedBy, version.ingestion?.requestedBy);
                assert.notEqual(b.requestedBy, version.ingestion?.requestedBy);
                await scanSync(fixture, [
                    first.generationId,
                    second.generationId,
                ]);
                for (const entry of [first, second]) {
                    const publication = await assertSyncVersion(
                        entry.generationId,
                        first.documentId,
                        2
                    );
                    assert.equal(publication.sourceVersionId, version.id);
                    const result = await f.owner.rag.indexing.search({
                        ...query,
                        collectionId: entry.collection.id,
                    });
                    assert(result.results.length > 0);
                    assert(
                        result.results.every(
                            (row) => row.version === 2 && row.parentContext
                        )
                    );
                    const original = await f.owner.rag.indexing.sourceOriginal({
                        collectionId: entry.collection.id,
                        receipt: result.results[0]!.source.receipt,
                    });
                    assert.equal(await original.text(), nextText);
                    await assertSyncDenied(
                        f.reader.rag.indexing.search({
                            ...query,
                            collectionId: entry.collection.id,
                        })
                    );
                    await assertSyncDenied(
                        f.reader.rag.indexing.start({
                            collectionId: entry.collection.id,
                            expectedRevision: 1,
                            requestId: randomUUID(),
                        })
                    );
                }
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: first.collection.id,
                            receipt,
                        })
                    ).text(),
                    parentText
                );
                assert.equal(
                    (
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: { versionId: version.id },
                        })
                    ).requestedBy,
                    f.users[2]
                );
            }
        );

        await t.test(
            'a library event received during the initial build catches up under its accepting controller before activation',
            async () => {
                const entry = await startSyncCollection(fixture, {
                    name: 'Initial generation catch-up',
                    scan: false,
                });
                const version = await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nInitial catch-up v2.`
                );
                const task = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(task.requestedBy, f.users[0]);
                const before = await prisma.indexGeneration.findUniqueOrThrow({
                    where: { id: entry.generationId },
                });
                assert.equal(before.previousGenerationId, null);
                await waitSyncActive(fixture, entry.generationId);
                const after = await prisma.indexGeneration.findUniqueOrThrow({
                    where: { id: entry.generationId },
                });
                const collection = await prisma.collection.findUniqueOrThrow({
                    where: { id: entry.collection.id },
                });
                assert.equal(after.status, 'ACTIVE');
                assert.equal(after.appliedSequence, collection.contentSequence);
                assert.equal(
                    (await assertSyncVersion(after.id, entry.documentId, 2))
                        .sourceVersionId,
                    version.id
                );
                assert.equal(
                    await prisma.indexedDocument.count({
                        where: {
                            generationId: after.id,
                            sourceVersion: { version: 1 },
                            status: 'PUBLISHED',
                        },
                    }),
                    0
                );
            }
        );

        await t.test(
            'historical null authority is UNADOPTED and never silently falls back to a valid creator',
            async () => {
                const entry = await startSyncCollection(fixture, {
                    name: 'Historical unadopted index',
                });
                // The mutable nullable field represents a historical generation; no source/layout state is forged.
                await prisma.indexGeneration.update({
                    where: { id: entry.generationId },
                    data: { authorityUserId: null },
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nHistorical v2.`
                );
                const task = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(task.requestedBy, f.users[2]);
                const calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                const failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(failed.status, 'FAILED');
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                assert.equal(fixture.state.embedCalls, calls);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                const status = await f.owner.rag.indexing.status({
                    collectionId: entry.collection.id,
                });
                assert.equal(
                    status.active?.synchronization?.authorityState,
                    'UNADOPTED'
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.manager.rag.indexing.adoptSynchronization({
                    collectionId: entry.collection.id,
                    generationId: entry.generationId,
                    expectedAuthorityUserId: null,
                });
                assert.equal(
                    (
                        await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        )
                    ).status,
                    'FAILED',
                    'Adoption alone must not reset a failed task.'
                );
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: failed.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
            }
        );

        await t.test(
            'pending rebuild retains stronger controller grants while an ACTIVE predecessor and later ACTIVE successor need ordinary management',
            async () => {
                const entry = await startSyncCollection(fixture, {
                    name: 'Rebuild controller boundary',
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.collections.update({
                    id: entry.collection.id,
                    expectedRevision: 1,
                    name: entry.collection.name,
                    description: '',
                    profile: parentProfile('TOKEN_WINDOW', 256),
                });
                const rebuilding = await f.owner.rag.indexing.rebuild({
                    collectionId: entry.collection.id,
                    expectedRevision: 2,
                    expectedActiveGenerationId: entry.generationId,
                    requestId: randomUUID(),
                });
                // Historical pending rebuilds keep their documented original-creator fallback only until explicitly transferred.
                await prisma.indexGeneration.update({
                    where: { id: rebuilding.generationId },
                    data: { authorityUserId: null },
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: syncManageGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nPending B v2.`
                );
                assert.equal(
                    (
                        await currentSyncTask(
                            rebuilding.generationId,
                            entry.documentId
                        )
                    ).requestedBy,
                    f.users[0]
                );
                await scanSync(
                    fixture,
                    [entry.generationId, rebuilding.generationId],
                    3
                );
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: entry.collection.id,
                        })
                    ).active?.id,
                    entry.generationId
                );
                await assertSyncDenied(
                    f.manager.rag.indexing.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: rebuilding.generationId,
                        expectedAuthorityUserId: null,
                    })
                );
                const failed = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        generationId: rebuilding.generationId,
                        kind: 'PROVISION',
                        status: 'FAILED',
                    },
                });
                await assertSyncDenied(
                    f.manager.rag.indexing.retry({
                        collectionId: entry.collection.id,
                        taskId: failed.id,
                    })
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: { ...syncManageGrant, administer: true },
                });
                await f.owner.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: failed.id,
                });
                await waitSyncActive(fixture, rebuilding.generationId);
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: entry.collection.id,
                        })
                    ).active?.id,
                    rebuilding.generationId
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: rebuilding.generationId },
                        })
                    ).authorityUserId,
                    f.users[0]
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: syncManageGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nActive former B v3.`
                );
                await scanSync(fixture, [rebuilding.generationId]);
                await assertSyncVersion(
                    rebuilding.generationId,
                    entry.documentId,
                    3
                );
            }
        );
    } finally {
        await fixture.close();
    }
}
