import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createSemanticFixture,
    scanSemantic,
    semanticText,
} from './semantic-fixtures';

/** Real semantic holders keep their admitted allowances when policy grows under an already-full organization cap. */
export async function semanticCapacityTests(t: TestContext) {
    const fixture = await createSemanticFixture('capacity increase');
    try {
        const actor = await prisma.user.findUniqueOrThrow({
            where: { id: f.users[0] },
            select: { id: true, isSuperAdmin: true },
        });
        try {
            await t.test(
                'raising semantic per-candidate caps cannot deadlock already-admitted work or planning storage',
                async () => {
                    await prisma.user.update({
                        where: { id: actor.id },
                        data: { isSuperAdmin: true },
                    });
                    const current =
                        await f.owner.client.superadmin.organizations.getSemanticQuota(
                            { organizationId: f.org }
                        );
                    const limits = {
                        ...current.limits,
                        semanticPlanBytesPerDocument: 16_384,
                        semanticPlanBytesPerOrganization: 4 * 16_384,
                        embeddingPreparedBytesPerCandidate: 16_384,
                        embeddingBatchesPerCandidate: 16,
                        embeddingOutstandingPreparedBytes: 4 * 16_384,
                        embeddingOutstandingBatches: 4 * 16,
                    };
                    await f.owner.client.superadmin.organizations.setSemanticQuota(
                        { organizationId: f.org, limits }
                    );
                    const collection = await fixture.collection();
                    for (let index = 0; index < 4; index++)
                        await fixture.upload(
                            semanticText(64),
                            `cap-increase-${index}.txt`,
                            collection.id
                        );
                    const started = await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await fixture.scan(1); // Provision only.
                    await fixture.scan(1); // Four admitted32-unit prefixes, no deadline rewriting.
                    const before = await prisma.semanticChunkPlan.findMany({
                        where: { generationId: started.generationId },
                    });
                    assert.equal(before.length, 4);
                    assert(
                        before.every(
                            (plan) =>
                                plan.state === 'PLANNING' &&
                                plan.unitCount === 64 &&
                                plan.completedUnits === 32 &&
                                plan.reservedPreparedBytes > 0n &&
                                plan.reservedBatches > 0
                        )
                    );
                    const held =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    assert.equal(
                        held.reservedPlanBytes + held.storedPlanBytes,
                        65_536n
                    );
                    assert.equal(
                        held.reservedPreparedBytes +
                            held.dispatchedPreparedBytes,
                        65_536n
                    );
                    assert.equal(
                        held.reservedBatches + held.dispatchedBatches,
                        64n
                    );
                    const raised = {
                        ...limits,
                        semanticPlanBytesPerDocument: 32_768,
                        embeddingPreparedBytesPerCandidate: 32_768,
                        embeddingBatchesPerCandidate: 32,
                    };
                    await f.owner.client.superadmin.organizations.setSemanticQuota(
                        { organizationId: f.org, limits: raised }
                    );
                    await scanSemantic(fixture, started.generationId, 4);
                    const status = await f.owner.rag.indexing.status({
                        collectionId: collection.id,
                    });
                    assert.equal(status.active?.id, started.generationId);
                    const tasks = await prisma.indexTask.findMany({
                        where: {
                            generationId: started.generationId,
                            kind: 'INDEX_DOCUMENT',
                        },
                    });
                    assert.equal(tasks.length, 4);
                    assert(
                        tasks.every(
                            (task) =>
                                task.status === 'COMPLETE' &&
                                task.attempts === 1 &&
                                task.continuations >= 1 &&
                                task.errorCode === null
                        )
                    );
                    const plans = await prisma.semanticChunkPlan.findMany({
                        where: { generationId: started.generationId },
                    });
                    assert(
                        plans.every(
                            (plan) =>
                                plan.state === 'READY' &&
                                plan.completedUnits === 64 &&
                                plan.reservedPreparedBytes === 0n &&
                                plan.reservedBatches === 0 &&
                                plan.reservedBytes === 0n &&
                                plan.storedBytes <= 16_384n
                        )
                    );
                    const released =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    assert.equal(released.reservedPlanBytes, 0n);
                    assert.equal(released.reservedPreparedBytes, 0n);
                    assert.equal(released.reservedBatches, 0n);
                    assert(
                        released.storedPlanBytes > 0n &&
                            released.storedPlanBytes <= 65_536n
                    );
                    assert.deepEqual(
                        (
                            await f.owner.client.superadmin.organizations.getSemanticQuota(
                                { organizationId: f.org }
                            )
                        ).limits,
                        raised
                    );
                }
            );
        } finally {
            await prisma.user.update({
                where: { id: actor.id },
                data: { isSuperAdmin: actor.isSuperAdmin },
            });
        }
    } finally {
        await fixture.close();
    }
}
