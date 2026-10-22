import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { fixture as f } from './fixtures';
import { candidateTask, semanticText } from './semantic-fixtures';
import {
    assertParentPublication,
    createParentFixture,
    parentProfile,
    scanParent,
} from './parent-fixtures';

/** Real interrupted application materialization and sealed-plan replay; injected faults affect only owned generations. */
export async function parentRetryTests(t: TestContext) {
    const fixture = await createParentFixture('Layout retries');
    try {
        await t.test(
            'parents committed before a child insertion fault are validated and reused by a real retry',
            async () => {
                const collection = await fixture.collection(
                    'Partial parent layout'
                );
                const text = parentProfile().model + '\n' + semanticText(80);
                const source = await fixture.upload(
                    text,
                    'parent-partial.txt',
                    collection.id
                );
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await scanParent(fixture, started.generationId, 1); // Provision only.
                const identifier = `parent_fault_${randomUUID().replaceAll('-', '')}`;
                assert.match(identifier, /^[a-z_][a-z\d_]{0,62}$/u);
                assert.match(started.generationId, /^[a-f\d-]{36}$/u);
                // Test-only DDL cannot be expressed by Prisma. Both interpolations are generated and validated;
                // the trigger is scoped to one generation in the runner-owned _test database.
                await prisma.$executeRawUnsafe(
                    `CREATE FUNCTION "${identifier}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."generationId"='${started.generationId}' AND NEW.kind='CHILD' THEN RAISE EXCEPTION 'owned parent materialization fault'; END IF; RETURN NEW; END $$`
                );
                try {
                    await prisma.$executeRawUnsafe(
                        `CREATE TRIGGER "${identifier}" BEFORE INSERT ON "Chunk" FOR EACH ROW EXECUTE FUNCTION "${identifier}"()`
                    );
                    try {
                        const calls = fixture.state.embedCalls;
                        await scanParent(fixture, started.generationId, 1);
                        const task = await candidateTask(
                            started.generationId,
                            source.id
                        );
                        assert(task.indexedDocumentId);
                        const candidate =
                            await prisma.indexedDocument.findUniqueOrThrow({
                                where: { id: task.indexedDocumentId },
                            });
                        const retainedParents = await prisma.chunk.findMany({
                            where: {
                                indexedDocumentId: candidate.id,
                                kind: 'PARENT',
                            },
                            orderBy: { ordinal: 'asc' },
                        });
                        assert(retainedParents.length > 0);
                        assert.equal(
                            await prisma.chunk.count({
                                where: {
                                    indexedDocumentId: candidate.id,
                                    kind: 'CHILD',
                                },
                            }),
                            0
                        );
                        assert.equal(candidate.status, 'STAGING');
                        assert.equal(candidate.materializedChunks, 0);
                        assert.equal(fixture.state.embedCalls, calls);
                        assert.equal(
                            (
                                await f.owner.rag.indexing.status({
                                    collectionId: collection.id,
                                })
                            ).active,
                            null
                        );
                        await prisma.$executeRawUnsafe(
                            `DROP TRIGGER "${identifier}" ON "Chunk"`
                        );
                        if (task.status === 'FAILED')
                            await f.owner.rag.indexing.retry({
                                collectionId: collection.id,
                                taskId: task.id,
                            });
                        else assert.equal(task.status, 'PENDING');
                        await scanParent(fixture, started.generationId, 6);
                        const completed = await assertParentPublication(
                            started.generationId,
                            source.id,
                            text
                        );
                        assert.equal(completed.candidate.id, candidate.id);
                        assert.deepEqual(
                            completed.parents.map((row) => [
                                row.id,
                                row.ordinal,
                                row.textHash,
                            ]),
                            retainedParents.map((row) => [
                                row.id,
                                row.ordinal,
                                row.textHash,
                            ])
                        );
                    } finally {
                        await prisma.$executeRawUnsafe(
                            `DROP TRIGGER IF EXISTS "${identifier}" ON "Chunk"`
                        );
                    }
                } finally {
                    await prisma.$executeRawUnsafe(
                        `DROP FUNCTION "${identifier}"()`
                    );
                }
            }
        );

        await t.test(
            'a parent-disabled sealed semantic plan retains its historical hash and boundary prefix on retry',
            async () => {
                const collection = await f.owner.rag.collections.create({
                    name: 'Legacy sealed semantic plan',
                    grantCreatorRead: true,
                    profile: {
                        ...parentProfile('SEMANTIC'),
                        parentChild: false,
                    },
                });
                const source = await fixture.upload(
                    semanticText(12),
                    'legacy-semantic-parent-off.txt',
                    collection.id
                );
                const quota = await prisma.organizationQuota.findUniqueOrThrow({
                    where: { organizationId: f.org },
                });
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await prisma.organizationQuota.update({
                    where: { organizationId: f.org },
                    data: { chunksPerCollection: 1 },
                });
                try {
                    await scanParent(fixture, started.generationId, 6);
                    const failed = await candidateTask(
                        started.generationId,
                        source.id
                    );
                    assert.equal(failed.status, 'FAILED');
                    assert.equal(failed.errorCode, 'QUOTA_EXCEEDED');
                    assert(failed.indexedDocumentId);
                    const plan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                            },
                        });
                    assert.equal(plan.state, 'READY');
                    assert(plan.sealedAt);
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: started.generationId },
                            })
                        ).parentContextVersion,
                        null
                    );
                    // Lock the exact pre-M6c JSON variant, not merely before/after hashes
                    // produced by this implementation. The controlled model's verified
                    // 2048-token Generic input budget is 2048 - 32 = 2016 bytes.
                    const candidate =
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: failed.indexedDocumentId },
                            include: {
                                generation: {
                                    include: { configuration: true },
                                },
                            },
                        });
                    const configuration = candidate.generation.configuration;
                    const legacyHash = createHash('sha256')
                        .update(
                            JSON.stringify({
                                revision:
                                    candidate.generation.configurationRevision,
                                provider: configuration.provider,
                                model: configuration.model,
                                dimensions: configuration.dimensions,
                                preset: configuration.embeddingPreset,
                                preparation: configuration.preparation,
                                credentialId: configuration.credentialId,
                                credentialRevision:
                                    configuration.credentialRevision,
                                endpoint: configuration.endpoint,
                                fileName: candidate.fileName,
                                sourceVersionId: candidate.sourceVersionId,
                                extractionId: candidate.extractionId,
                                capabilitySnapshot:
                                    candidate.generation.capabilitySnapshot,
                                options: {
                                    ...collectionProfile.shape.chunking.parse(
                                        configuration.chunking
                                    ),
                                    maxEmbeddingInputBytes: 2016,
                                },
                            })
                        )
                        .digest('hex');
                    assert.equal(plan.profileHash, legacyHash);
                    const boundaries = await prisma.embeddingWorkAttempt.count({
                        where: {
                            indexedDocumentId: failed.indexedDocumentId,
                            purpose: 'BOUNDARY',
                        },
                    });
                    assert(boundaries > 0);
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            chunksPerCollection: quota.chunksPerCollection,
                        },
                    });
                    fixture.state.vectorForText = () => [1, 1, 7];
                    await f.owner.rag.indexing.retry({
                        collectionId: collection.id,
                        taskId: failed.id,
                    });
                    await scanParent(fixture, started.generationId, 6);
                    const after =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                            },
                        });
                    assert.equal(after.profileHash, plan.profileHash);
                    assert.equal(after.planHash, plan.planHash);
                    assert.deepEqual(after.finalRanges, plan.finalRanges);
                    assert.deepEqual(after.boundaryScores, plan.boundaryScores);
                    assert.equal(
                        await prisma.embeddingWorkAttempt.count({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                                purpose: 'BOUNDARY',
                            },
                        }),
                        boundaries
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active?.id,
                        started.generationId
                    );
                    assert.equal(
                        await prisma.chunk.count({
                            where: {
                                generationId: started.generationId,
                                kind: 'PARENT',
                            },
                        }),
                        0
                    );
                    const preview = await f.owner.rag.indexing.chunks({
                        collectionId: collection.id,
                    });
                    assert(
                        preview.items.every(
                            (row) => row.parentContext === undefined
                        )
                    );
                } finally {
                    delete fixture.state.vectorForText;
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            chunksPerCollection: quota.chunksPerCollection,
                        },
                    });
                }
            }
        );
    } finally {
        await fixture.close();
    }
}
