import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';

/** Real catalog/vector/object state with a controlled provider verifies publication, retry and quota invariants. */
export async function indexWorkerTests(t: TestContext) {
    const environment = await createIndexingFixture();
    try {
        const collection = await environment.collection('Durable first index');
        const document = await environment.upload(
            '# French wildlife\n' +
                'Les renards vivent dans les forêts.\n'.repeat(6) +
                '\n# English wildlife\n' +
                'Foxes live in forests.\n'.repeat(6),
            'animals.md',
            collection.id
        );
        const requestId = randomUUID();
        const started = await f.owner.rag.indexing.start({
            collectionId: collection.id,
            expectedRevision: 1,
            requestId,
        });
        await environment.scan();
        await t.test(
            'first generation publishes exact immutable sources and accounts materialized chunks once',
            async () => {
                const generation =
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: started.generationId },
                    });
                assert.equal(generation.status, 'ACTIVE');
                const publication =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: {
                            generationId: generation.id,
                            documentId: document.id,
                            status: 'PUBLISHED',
                        },
                        include: { sourceHold: true, chunks: true },
                    });
                assert.equal(
                    publication.materializedChunks,
                    publication.chunkCount
                );
                assert.equal(
                    publication.chunkCount,
                    2,
                    'Native Markdown uploads preserve heading boundaries even when both sections fit one input.'
                );
                assert(
                    publication.chunks.every(
                        (chunk) =>
                            !(
                                chunk.text.includes('# French wildlife') &&
                                chunk.text.includes('# English wildlife')
                            )
                    )
                );
                assert.equal(publication.sourceHold?.state, 'LIVE');
                assert.equal(
                    publication.sourceHold?.versionId,
                    publication.sourceVersionId
                );
                assert(
                    publication.chunks.every(
                        (chunk) =>
                            chunk.tokenCountIsEstimate &&
                            chunk.textHash.length === 64 &&
                            chunk.embeddingInputHash?.length === 64
                    )
                );
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(
                    usage.activeChunks,
                    BigInt(publication.chunkCount)
                );
                assert.equal(usage.retainedChunks, 0n);
                assert.equal(usage.reservedChunks, 0n);
                const calls = environment.state.embedCalls;
                assert.deepEqual(
                    await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId,
                    }),
                    started
                );
                await environment.scan();
                assert.equal(environment.state.embedCalls, calls);
            }
        );
        await t.test(
            'reclaimed post-seal task adopts immutable vectors without repeating provider cost',
            async () => {
                // Reconstruct the durable boundary after vector seal but before the
                // catalog publication transaction committed. No external vector row is changed.
                const publication =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: {
                            generationId: started.generationId,
                            documentId: document.id,
                            status: 'PUBLISHED',
                        },
                    });
                await prisma.$transaction(async (tx) => {
                    await tx.collection.update({
                        where: { id: collection.id },
                        data: { activeGenerationId: null },
                    });
                    await tx.indexGeneration.update({
                        where: { id: started.generationId },
                        data: { status: 'BUILDING' },
                    });
                    await tx.generationDocument.update({
                        where: {
                            ['generationId_documentId']: {
                                generationId: started.generationId,
                                documentId: document.id,
                            },
                        },
                        data: { publishedIndexedDocumentId: null },
                    });
                    await tx.indexedDocument.update({
                        where: { id: publication.id },
                        data: {
                            status: 'STAGING',
                            manifestHash: null,
                            vectorSealedAt: null,
                            publishedAt: null,
                        },
                    });
                    await tx.collectionIndexAccounting.update({
                        where: { collectionId: collection.id },
                        data: {
                            activeChunks: 0,
                            retainedChunks: publication.chunkCount,
                        },
                    });
                    await tx.indexTask.updateMany({
                        where: {
                            indexedDocumentId: publication.id,
                            kind: 'INDEX_DOCUMENT',
                        },
                        data: {
                            status: 'PROCESSING',
                            leaseToken: 'terminated-at-seal',
                            leasedUntil: new Date(0),
                            completedAt: null,
                        },
                    });
                });
                const calls = environment.state.embedCalls;
                await environment.scan();
                assert.equal(environment.state.embedCalls, calls);
                assert.equal(
                    (
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: publication.id },
                        })
                    ).status,
                    'PUBLISHED'
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).status,
                    'ACTIVE'
                );
            }
        );
        await t.test(
            'activation rechecks a current principal and an authorized retry transfers the accepted task',
            async () => {
                const publication =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: {
                            generationId: started.generationId,
                            status: 'PUBLISHED',
                        },
                    });
                await prisma.$transaction(async (tx) => {
                    await tx.collection.update({
                        where: { id: collection.id },
                        data: { activeGenerationId: null },
                    });
                    await tx.indexGeneration.update({
                        where: { id: started.generationId },
                        data: { status: 'BUILDING' },
                    });
                    await tx.collectionIndexAccounting.update({
                        where: { collectionId: collection.id },
                        data: {
                            activeChunks: 0,
                            retainedChunks: publication.chunkCount,
                        },
                    });
                });
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: true,
                        manageDocuments: false,
                        administer: true,
                    },
                });
                await environment.scan(1);
                const failed = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        generationId: started.generationId,
                        status: 'FAILED',
                        stage: 'ACTIVATION',
                    },
                });
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                assert.equal(
                    (
                        await prisma.collection.findUniqueOrThrow({
                            where: { id: collection.id },
                        })
                    ).activeGenerationId,
                    null
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: false,
                    },
                });
                await f.manager.rag.indexing.retry({
                    collectionId: collection.id,
                    taskId: failed.id,
                });
                await environment.scan();
                assert.equal(
                    (
                        await prisma.indexTask.findUniqueOrThrow({
                            where: { id: failed.id },
                        })
                    ).requestedBy,
                    f.users[3]
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).status,
                    'ACTIVE'
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                });
            }
        );
        await t.test(
            'failed replacement keeps the previous publication searchable and retained work visible for retry',
            async () => {
                const previous = await prisma.indexedDocument.findFirstOrThrow({
                    where: {
                        generationId: started.generationId,
                        documentId: document.id,
                        status: 'PUBLISHED',
                    },
                });
                await f.owner.rag.documents.replace({
                    id: document.id,
                    expectedVersionId: previous.sourceVersionId,
                    requestId: randomUUID(),
                    file: new File(
                        [
                            'Solar energy powers buildings. L’énergie solaire alimente les bâtiments.\n'.repeat(
                                40
                            ),
                        ],
                        'energy.md'
                    ),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                environment.state.rejectEmbeddings = true;
                await environment.scan(1);
                const candidate = await prisma.indexedDocument.findFirstOrThrow(
                    {
                        where: {
                            generationId: started.generationId,
                            documentId: document.id,
                            status: 'STAGING',
                        },
                    }
                );
                assert.notEqual(
                    candidate.sourceVersionId,
                    previous.sourceVersionId
                );
                const desired =
                    await prisma.generationDocument.findUniqueOrThrow({
                        where: {
                            ['generationId_documentId']: {
                                generationId: started.generationId,
                                documentId: document.id,
                            },
                        },
                    });
                assert.equal(desired.publishedIndexedDocumentId, previous.id);
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(usage.activeChunks, BigInt(previous.chunkCount));
                assert.equal(
                    usage.retainedChunks,
                    BigInt(candidate.chunkCount)
                );
                assert.equal(usage.reservedChunks, 0n);
                const task = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        indexedDocumentId: candidate.id,
                        kind: 'INDEX_DOCUMENT',
                    },
                });
                assert.equal(task.errorCode, 'PROVIDER_REJECTED');
                assert(
                    !JSON.stringify(task, (_key, value) =>
                        typeof value === 'bigint' ? value.toString() : value
                    ).includes('synthetic-private-provider-body')
                );
                environment.state.rejectEmbeddings = false;
                await prisma.indexTask.update({
                    where: { id: task.id },
                    data: { availableAt: new Date() },
                });
                await environment.scan();
                assert.equal(
                    (
                        await prisma.generationDocument.findUniqueOrThrow({
                            where: {
                                ['generationId_documentId']: {
                                    generationId: started.generationId,
                                    documentId: document.id,
                                },
                            },
                        })
                    ).publishedIndexedDocumentId,
                    candidate.id
                );
                const hold = await prisma.documentSourceHold.findUniqueOrThrow({
                    where: { indexedDocumentId: previous.id },
                });
                assert.equal(hold.state, 'RETIRED');
                assert(hold.retainUntil! > new Date(Date.now() + 15 * 60_000));
            }
        );
        await t.test(
            'quota admission rejects projected growth before provider calls and releases failed candidates on detach',
            async () => {
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                const originalQuota = await prisma.organizationQuota.findUnique(
                    { where: { organizationId: f.org } }
                );
                const quota = {
                    collections: 20,
                    documents: 5000,
                    originalBytes: 25n * 1024n ** 2n,
                    storageBytes: 10n * 1024n ** 3n,
                    chunksPerCollection: Number(usage.activeChunks),
                    temporaryChunksPerCollection: 100_000,
                };
                await prisma.organizationQuota.upsert({
                    where: { organizationId: f.org },
                    create: { organizationId: f.org, ...quota },
                    update: { chunksPerCollection: quota.chunksPerCollection },
                });
                try {
                    const added = await environment.upload(
                        'Additional indexed source exceeds the current active target.\n'.repeat(
                            60
                        ),
                        'quota.txt',
                        collection.id
                    );
                    const calls = environment.state.embedCalls;
                    await environment.scan();
                    const candidate =
                        await prisma.indexedDocument.findFirstOrThrow({
                            where: {
                                generationId: started.generationId,
                                documentId: added.id,
                            },
                        });
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            indexedDocumentId: candidate.id,
                            kind: 'INDEX_DOCUMENT',
                        },
                    });
                    assert.equal(task.status, 'FAILED');
                    assert.equal(task.errorCode, 'QUOTA_EXCEEDED');
                    assert.equal(candidate.chunkCount, 0);
                    assert.equal(environment.state.embedCalls, calls);
                    await f.owner.rag.documents.setCollection({
                        id: added.id,
                        collectionId: collection.id,
                        attached: false,
                    });
                    await environment.scan();
                    assert.equal(
                        (
                            await prisma.documentSourceHold.findUniqueOrThrow({
                                where: { indexedDocumentId: candidate.id },
                            })
                        ).state,
                        'RELEASED'
                    );
                } finally {
                    await (originalQuota
                        ? prisma.organizationQuota.update({
                              where: { organizationId: f.org },
                              data: {
                                  chunksPerCollection:
                                      originalQuota.chunksPerCollection,
                              },
                          })
                        : prisma.organizationQuota.delete({
                              where: { organizationId: f.org },
                          }));
                }
            }
        );
        await t.test(
            'active generations advance a long acknowledged gap through bounded periodic pages without a later mutation',
            async () => {
                const current = await prisma.collection.findUniqueOrThrow({
                    where: { id: collection.id },
                });
                const sequences = Array.from(
                    { length: 350 },
                    (_, index) => current.contentSequence + BigInt(index + 1)
                );
                await prisma.$transaction(async (tx) => {
                    await tx.collection.update({
                        where: { id: collection.id },
                        data: { contentSequence: sequences.at(-1)! },
                    });
                    await tx.collectionChange.createMany({
                        data: sequences.map((sequence) => ({
                            organizationId: f.org,
                            collectionId: collection.id,
                            documentId: document.id,
                            sequence,
                            kind: 'REMOVE',
                            dispatchedAt: new Date(),
                        })),
                    });
                    await tx.generationChange.createMany({
                        data: sequences.map((sequence, index) => ({
                            organizationId: f.org,
                            collectionId: collection.id,
                            generationId: started.generationId,
                            sequence,
                            status: index === 0 ? 'PENDING' : 'APPLIED',
                            effect: index === 0 ? null : 'REMOVED',
                            appliedAt: index === 0 ? null : new Date(),
                        })),
                    });
                });
                await environment.scan(1);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).appliedSequence,
                    current.contentSequence
                );
                await prisma.generationChange.update({
                    where: {
                        ['generationId_sequence']: {
                            generationId: started.generationId,
                            sequence: sequences[0]!,
                        },
                    },
                    data: {
                        status: 'APPLIED',
                        effect: 'REMOVED',
                        appliedAt: new Date(),
                    },
                });
                await environment.scan(1);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).appliedSequence,
                    current.contentSequence + 100n
                );
                await environment.scan(4);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).appliedSequence,
                    sequences.at(-1)
                );
            }
        );
        await t.test(
            'collection deletion waits for citation holds and cleans vectors before releasing counters and holds',
            async () => {
                const source = await prisma.indexedDocument.findFirstOrThrow({
                    where: {
                        generationId: started.generationId,
                        status: 'PUBLISHED',
                    },
                });
                const abandoned = Array.from({ length: 101 }, (_, index) => ({
                    id: randomUUID(),
                    organizationId: f.org,
                    collectionId: collection.id,
                    generationId: started.generationId,
                    documentId: source.documentId,
                    sourceVersionId: source.sourceVersionId,
                    extractionId: source.extractionId,
                    extractorVersion: source.extractorVersion,
                    buildRevision: index + 100,
                    metadataRevision: source.metadataRevision,
                    sourceChangeSequence: source.sourceChangeSequence,
                    fileName: source.fileName,
                    mediaType: source.mediaType,
                    language: source.language,
                    documentCreatedAt: source.documentCreatedAt,
                    sourceCreatedAt: source.sourceCreatedAt,
                }));
                await prisma.$transaction(async (tx) => {
                    await tx.documentVersion.update({
                        where: { id: source.sourceVersionId },
                        data: { contentFence: { increment: 1 } },
                    });
                    await tx.indexedDocument.createMany({ data: abandoned });
                    await tx.documentSourceHold.createMany({
                        data: abandoned.map((candidate) => ({
                            organizationId: f.org,
                            versionId: candidate.sourceVersionId,
                            indexedDocumentId: candidate.id,
                        })),
                    });
                });
                await f.owner.rag.collections.delete({
                    id: collection.id,
                    expectedRevision: 1,
                });
                await environment.scan(1);
                assert.equal(
                    await prisma.indexedDocument.count({
                        where: {
                            generationId: started.generationId,
                            status: { in: ['STAGING', 'SEALED', 'PUBLISHED'] },
                        },
                    }),
                    2,
                    'A destructive scan retires at most100 candidates.'
                );
                await prisma.indexTask.updateMany({
                    where: {
                        generationId: started.generationId,
                        kind: 'CLEAN_GENERATION',
                        status: 'PENDING',
                    },
                    data: { availableAt: new Date(0) },
                });
                await environment.scan(1);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).status,
                    'CLEANING'
                );
                assert(
                    await prisma.documentSourceHold.count({
                        where: {
                            indexedDocument: {
                                generationId: started.generationId,
                            },
                            state: 'RETIRED',
                        },
                    })
                );
                // Advance only this disposable fixture's retention clock; application sources are never used by this suite.
                await prisma.documentSourceHold.updateMany({
                    where: {
                        indexedDocument: { generationId: started.generationId },
                        state: 'RETIRED',
                    },
                    data: { retainUntil: new Date(0) },
                });
                await prisma.indexTask.updateMany({
                    where: {
                        generationId: started.generationId,
                        kind: { in: ['CLEAN_PUBLICATION', 'CLEAN_GENERATION'] },
                        status: 'PENDING',
                    },
                    data: { availableAt: new Date() },
                });
                for (let pass = 0; pass < 20; pass++) {
                    await prisma.indexTask.updateMany({
                        where: {
                            generationId: started.generationId,
                            kind: 'CLEAN_GENERATION',
                            status: 'PENDING',
                        },
                        data: { availableAt: new Date(0) },
                    });
                    await environment.scan(1);
                    if (
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: started.generationId },
                            })
                        ).status === 'CLEANED'
                    )
                        break;
                }
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).status,
                    'CLEANED'
                );
                assert.equal(
                    await prisma.chunk.count({
                        where: { generationId: started.generationId },
                    }),
                    0
                );
                assert.equal(
                    await prisma.documentSourceHold.count({
                        where: {
                            indexedDocument: {
                                generationId: started.generationId,
                            },
                            state: { not: 'RELEASED' },
                        },
                    }),
                    0
                );
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(
                    usage.activeChunks +
                        usage.retainedChunks +
                        usage.reservedChunks,
                    0n
                );
            }
        );
    } finally {
        await environment.close();
    }
}
