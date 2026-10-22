import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import {
    currentDocumentSnapshot,
    stageInitialSnapshot,
} from '@routers/rag/indexing-changes';
import { releaseSourceHold } from '@routers/rag/source-holds';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { fixture as f, profile } from './fixtures';

/**
 * Exercise acceptance/ordering with real PostgreSQL + S3 and an unprovisioned
 * generation fixture. These tests do not claim embedding/vector-provider I/O.
 */
export async function indexingOutboxTests(t: TestContext) {
    const settings = {
        ...profile,
        embeddingPreset: 'EMBEDDING_GEMMA' as const,
        metadataFields: {
            published: 'DATE' as const,
            category: 'STRING' as const,
            score: 'NUMBER' as const,
            archived: 'BOOLEAN' as const,
        },
    };
    const collection = await f.owner.rag.collections.create({
        name: `Outbox ${randomUUID()}`,
        grantCreatorRead: true,
        profile: settings,
    });
    const upload = await f.owner.rag.documents.upload({
        requestId: randomUUID(),
        file: new File(['Version un. First source text.'], 'outbox.txt'),
    });
    await processDocumentIngestions(prisma);
    let generationId: string | undefined;
    const associationInput = { id: upload.id, collectionId: collection.id };
    function state() {
        return prisma.collection.findUniqueOrThrow({
            where: { id: collection.id },
        });
    }
    try {
        await t.test(
            'attach/detach replay emits one monotone event per actual association change',
            async () => {
                await f.owner.rag.documents.setCollection({
                    ...associationInput,
                    attached: true,
                });
                await f.owner.rag.documents.setCollection({
                    ...associationInput,
                    attached: true,
                });
                assert.equal((await state()).contentSequence, 1n);
                const event = await prisma.collectionChange.findFirstOrThrow({
                    where: { collectionId: collection.id },
                });
                assert.equal(event.kind, 'UPSERT');
                assert.equal(event.sourceVersionId, upload.versionId);
                assert.ok(event.dispatchedAt);
                assert.equal(
                    await prisma.collectionChange.count({
                        where: { collectionId: collection.id },
                    }),
                    1
                );
            }
        );
        await t.test(
            'initial snapshot pins exact source and accepts idempotent durable tasks without fake receipts',
            async () => {
                const id = randomUUID();
                generationId = id;
                const saved =
                    await prisma.collectionConfigRevision.findUniqueOrThrow({
                        where: {
                            ['organizationId_collectionId_revision']: {
                                organizationId: f.org,
                                collectionId: collection.id,
                                revision: 1,
                            },
                        },
                    });
                await runSerializableTransaction(prisma, async (tx) => {
                    const generation = await tx.indexGeneration.create({
                        data: {
                            id,
                            organizationId: f.org,
                            collectionId: collection.id,
                            requestId: randomUUID(),
                            configurationRevision: 1,
                            vectorConnectionId: saved.vectorConnectionId,
                            vectorSchema: 'vector_collections',
                            tableName: `g_${id.replaceAll('-', '')}`,
                            destinationFingerprint: 'unprovisioned-outbox-test',
                            modelIdentity: '0'.repeat(64),
                            capabilitySnapshot: {},
                            chunkerVersion: 'test-v1',
                            status: 'BUILDING',
                            snapshotSequence: 1n,
                            appliedSequence: 1n,
                            createdBy: f.users[0]!,
                        },
                    });
                    const snapshot = await currentDocumentSnapshot(
                        tx,
                        f.org,
                        collection.id,
                        upload.id
                    );
                    assert.ok(snapshot);
                    await tx.collectionIndexAccounting.create({
                        data: {
                            organizationId: f.org,
                            collectionId: collection.id,
                        },
                    });
                    await stageInitialSnapshot(
                        tx,
                        generation,
                        [snapshot],
                        f.users[0]!
                    );
                });
                const candidate = await prisma.indexedDocument.findFirstOrThrow(
                    {
                        where: { generationId: id },
                        include: { sourceHold: true, tasks: true },
                    }
                );
                assert.equal(candidate.buildRevision, 1);
                assert.equal(candidate.sourceVersionId, upload.versionId);
                assert.equal(candidate.sourceHold?.state, 'LIVE');
                assert.equal(candidate.tasks.length, 1);
                assert.equal(candidate.tasks[0]?.changeSequence, null);
                assert.equal(candidate.tasks[0]?.reservedChunks, 0);
                assert.equal(
                    await prisma.generationChange.count({
                        where: { generationId: id },
                    }),
                    0
                );
            }
        );
        await t.test(
            'typed metadata is canonical, immutable in old events and optimistic; failed changes roll back sequence/audit',
            async () => {
                const change = {
                    collectionId: collection.id,
                    documentId: upload.id,
                    expectedMetadataRevision: 1,
                    language: 'MIXED' as const,
                    tags: ['legal', 'legal', 'fr-en'],
                    metadata: {
                        published: '2025-10-12T10:30:00+02:00',
                        category: 'contracts',
                        score: 3.5,
                        archived: false,
                    },
                };
                await f.owner.rag.indexing.updateMetadata(change);
                const association =
                    await prisma.collectionDocument.findUniqueOrThrow({
                        where: {
                            ['collectionId_documentId']: {
                                collectionId: collection.id,
                                documentId: upload.id,
                            },
                        },
                    });
                assert.equal(association.metadataRevision, 2);
                assert.deepEqual(association.tags, ['legal', 'fr-en']);
                assert.deepEqual(association.metadata, {
                    ...change.metadata,
                    published: '2025-10-12T08:30:00.000Z',
                });
                assert.equal((await state()).contentSequence, 2n);
                const events = await prisma.collectionChange.findMany({
                    where: { collectionId: collection.id },
                    orderBy: { sequence: 'asc' },
                });
                assert.deepEqual(events[0]?.metadata, {});
                assert.deepEqual(events[1]?.metadata, association.metadata);
                assert.equal(events[1]?.metadataRevision, 2);
                const desired =
                    await prisma.generationDocument.findUniqueOrThrow({
                        where: {
                            ['generationId_documentId']: {
                                generationId: generationId!,
                                documentId: upload.id,
                            },
                        },
                    });
                assert.equal(desired.buildRevision, 2);
                assert.equal(desired.desiredChangeSequence, 2n);
                const candidates = await prisma.indexedDocument.findMany({
                    where: { generationId },
                    orderBy: { buildRevision: 'asc' },
                    include: { sourceHold: true, tasks: true },
                });
                assert.equal(candidates[0]?.status, 'RETIRED');
                assert.equal(candidates[0]?.sourceHold?.state, 'RETIRED');
                assert.equal(candidates[1]?.metadataRevision, 2);
                assert.equal(candidates[1]?.sourceHold?.state, 'LIVE');
                assert.equal(candidates[1]?.tasks[0]?.changeSequence, 2n);
                const auditCount = await prisma.ragAuditLog.count({
                    where: {
                        organizationId: f.org,
                        targetId: upload.id,
                        action: 'document.collection.metadata',
                    },
                });
                await assert.rejects(
                    f.owner.rag.indexing.updateMetadata(change),
                    { code: 'CONFLICT' }
                );
                const invalidMetadata: Record<
                    string,
                    string | number | boolean
                >[] = [
                    { published: '2025-02-30T00:00:00Z' },
                    { undeclared: 'x' },
                    { score: 'wrong' },
                ];
                for (const metadata of invalidMetadata) {
                    await assert.rejects(
                        f.owner.rag.indexing.updateMetadata({
                            ...change,
                            expectedMetadataRevision: 2,
                            metadata,
                        }),
                        { code: 'BAD_REQUEST' }
                    );
                }
                assert.equal((await state()).contentSequence, 2n);
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: {
                            organizationId: f.org,
                            targetId: upload.id,
                            action: 'document.collection.metadata',
                        },
                    }),
                    auditCount
                );
            }
        );
        await t.test(
            'version publication, detach and reattach use fresh candidate IDs and exact ordered receipts',
            async () => {
                const replacement = await f.owner.rag.documents.replace({
                    id: upload.id,
                    expectedVersionId: upload.versionId,
                    requestId: randomUUID(),
                    file: new File(
                        ['Version deux. Second retained source.'],
                        'outbox-v2.txt'
                    ),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                assert.equal((await state()).contentSequence, 3n);
                const event = await prisma.collectionChange.findUniqueOrThrow({
                    where: {
                        ['organizationId_collectionId_sequence']: {
                            organizationId: f.org,
                            collectionId: collection.id,
                            sequence: 3n,
                        },
                    },
                });
                assert.equal(event.sourceVersionId, replacement.versionId);
                assert.equal(event.metadataRevision, 2);
                const latestCandidate =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: { generationId, buildRevision: 3 },
                    });
                await f.owner.rag.documents.setCollection({
                    ...associationInput,
                    attached: false,
                });
                await f.owner.rag.documents.setCollection({
                    ...associationInput,
                    attached: false,
                });
                assert.equal((await state()).contentSequence, 4n);
                const detached =
                    await prisma.generationDocument.findUniqueOrThrow({
                        where: {
                            ['generationId_documentId']: {
                                generationId: generationId!,
                                documentId: upload.id,
                            },
                        },
                    });
                assert.equal(detached.desiredVersionId, null);
                assert.equal(detached.desiredExtractionId, null);
                assert.ok(detached.removedAt);
                assert.equal(detached.buildRevision, 4);
                assert.equal(
                    (
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: latestCandidate.id },
                        })
                    ).status,
                    'RETIRED'
                );
                await f.owner.rag.documents.setCollection({
                    ...associationInput,
                    attached: true,
                });
                assert.equal((await state()).contentSequence, 5n);
                const reattached =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: { generationId, buildRevision: 5 },
                    });
                assert.notEqual(reattached.id, latestCandidate.id);
                assert.equal(reattached.sourceVersionId, replacement.versionId);
                const receipts = await prisma.generationChange.findMany({
                    where: { generationId },
                    orderBy: { sequence: 'asc' },
                });
                assert.deepEqual(
                    receipts.map((receipt) => receipt.sequence),
                    [2n, 3n, 4n, 5n]
                );
                assert.ok(
                    await prisma.indexTask.findFirst({
                        where: {
                            generationId,
                            kind: 'REMOVE_DOCUMENT',
                            changeSequence: 4n,
                        },
                    })
                );
            }
        );
        await t.test(
            'indexed profile changes fail closed while name-only changes preserve binding and revision without credential resolution',
            async () => {
                const previousSelection =
                    await prisma.credentialSelection.findUnique({
                        where: {
                            ['organizationId_provider']: {
                                organizationId: f.org,
                                provider: 'OLLAMA',
                            },
                        },
                    });
                const credential = await f.owner.rag.credentials.create({
                    name: `Broken active binding ${randomUUID()}`,
                    data: {
                        provider: 'OLLAMA',
                        endpoint: 'http://127.0.0.1:11434',
                        apiKey: 'isolated-test-secret',
                    },
                });
                const before = await prisma.ollamaCredentials.findUniqueOrThrow(
                    { where: { id: credential.id } }
                );
                await f.owner.rag.credentials.activate({ id: credential.id });
                await prisma.ollamaCredentials.update({
                    where: { id: credential.id },
                    data: { apiKey: 'invalid-test-ciphertext' },
                });
                try {
                    const updated = await f.owner.rag.collections.update({
                        id: collection.id,
                        expectedRevision: 1,
                        name: 'Renamed while indexing',
                        description: 'Metadata only',
                        profile: settings,
                    });
                    assert.equal(updated.configurationRevision, 1);
                    assert.deepEqual(
                        updated.configuration,
                        collection.configuration
                    );
                    const oldWire = await f.owner.rag.collections.update({
                        id: collection.id,
                        expectedRevision: 1,
                        name: 'Old client name edit',
                        description:
                            'The previous V1 input omits newly introduced fields.',
                        profile,
                    });
                    assert.equal(oldWire.configurationRevision, 1);
                    assert.equal(
                        oldWire.configuration.embeddingPreset,
                        'EMBEDDING_GEMMA'
                    );
                    assert.deepEqual(
                        oldWire.configuration.metadataFields,
                        settings.metadataFields
                    );

                    await assert.rejects(
                        f.owner.rag.collections.update({
                            id: collection.id,
                            expectedRevision: 1,
                            name: updated.name,
                            description: updated.description,
                            profile: { ...settings, dimensions: 1024 },
                        }),
                        { code: 'CONFLICT' }
                    );
                    assert.equal((await state()).configurationRevision, 1);
                } finally {
                    await prisma.ollamaCredentials.update({
                        where: { id: credential.id },
                        data: { apiKey: before.apiKey },
                    });
                    await (previousSelection
                        ? f.owner.rag.credentials.activate({
                              id: previousSelection.credentialId,
                          })
                        : prisma.credentialSelection.deleteMany({
                              where: {
                                  organizationId: f.org,
                                  provider: 'OLLAMA',
                              },
                          }));
                }
            }
        );
        await t.test(
            'document deletion accepts REMOVE before private cleanup and collection deletion accepts durable generation cleanup',
            async () => {
                const latest = await prisma.documentVersion.findFirstOrThrow({
                    where: { documentId: upload.id },
                    orderBy: { version: 'desc' },
                });
                await f.owner.rag.documents.delete({
                    id: upload.id,
                    expectedVersionId: latest.id,
                    retentionDays: 0,
                });
                assert.equal((await state()).contentSequence, 6n);
                const removal = await prisma.collectionChange.findUniqueOrThrow(
                    {
                        where: {
                            ['organizationId_collectionId_sequence']: {
                                organizationId: f.org,
                                collectionId: collection.id,
                                sequence: 6n,
                            },
                        },
                    }
                );
                assert.equal(removal.kind, 'REMOVE');
                assert.equal(removal.sourceVersionId, null);
                await f.owner.rag.collections.delete({
                    id: collection.id,
                    expectedRevision: 1,
                });
                assert.equal((await state()).contentSequence, 7n);
                const deletion =
                    await prisma.collectionChange.findUniqueOrThrow({
                        where: {
                            ['organizationId_collectionId_sequence']: {
                                organizationId: f.org,
                                collectionId: collection.id,
                                sequence: 7n,
                            },
                        },
                    });
                assert.equal(deletion.kind, 'COLLECTION_DELETE');
                assert.ok(deletion.dispatchedAt);
                assert.ok(
                    await prisma.indexTask.findFirst({
                        where: {
                            generationId,
                            kind: 'CLEAN_GENERATION',
                            changeSequence: 7n,
                        },
                    })
                );
                await assert.rejects(
                    f.owner.rag.collections.get({ id: collection.id }),
                    { code: 'NOT_FOUND' }
                );
            }
        );
    } finally {
        // This fixture never provisioned a vector table or materialized a chunk.
        // Cancel its metadata-only work, release source holds, then exercise real
        // private-object cleanup rather than fabricating PURGED source metadata.
        if (generationId) {
            await runSerializableTransaction(prisma, async (tx) => {
                const candidates = await tx.indexedDocument.findMany({
                    where: { generationId },
                });
                for (const candidate of candidates)
                    await releaseSourceHold(tx, {
                        organizationId: f.org,
                        indexedDocumentId: candidate.id,
                    });
                await tx.indexedDocument.updateMany({
                    where: { generationId },
                    data: { status: 'CLEANED' },
                });
                await tx.indexTask.updateMany({
                    where: { generationId },
                    data: {
                        status: 'CANCELLED',
                        leaseToken: null,
                        leasedUntil: null,
                    },
                });
                await tx.indexGeneration.update({
                    where: { id: generationId },
                    data: { status: 'CLEANED' },
                });
            });
        }
        const latest = await prisma.documentVersion.findFirstOrThrow({
            where: { documentId: upload.id },
            orderBy: { version: 'desc' },
        });
        await f.owner.rag.documents.delete({
            id: upload.id,
            expectedVersionId: latest.id,
            retentionDays: 0,
        });
        await prisma.documentIngestion.updateMany({
            where: { version: { documentId: upload.id } },
            data: { leasedUntil: new Date(0) },
        });
        await prisma.documentCleanup.updateMany({
            where: { version: { documentId: upload.id } },
            data: {
                scheduledAt: new Date(0),
                availableAt: new Date(0),
                status: 'PENDING',
            },
        });
        await processDocumentCleanups(prisma);
        if (!(await state()).deletedAt)
            await f.owner.rag.collections.delete({
                id: collection.id,
                expectedRevision: 1,
            });
    }
}
