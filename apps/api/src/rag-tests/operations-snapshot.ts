import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f } from './fixtures';
import {
    createOperationsFixture,
    operationCounts,
    queueOperationsDocument,
} from './operations-fixtures';

/** Read-only operational states use the actual snapshot time; controlled claims model crash/defer state, never forged completion. */
export async function operationsSnapshotTests(t: TestContext) {
    await t.test(
        'operations classify all durable ingestion states at one observation without reading as retry or worker health',
        async () => {
            const fixture = await createOperationsFixture('Snapshot states');
            try {
                const invalid = await queueOperationsDocument(
                    'Ops states invalid.txt',
                    new Uint8Array([0xff, 0xfe])
                );
                await processDocumentIngestions(prisma);
                assert.equal(
                    (
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: { versionId: invalid.version.id },
                        })
                    ).errorCode,
                    'TEXT_INVALID'
                );
                const now = Date.now();
                const states = [
                    {
                        name: 'upload',
                        status: 'UPLOADING',
                        state: 'UPLOADING',
                        availableAt: new Date(now - 600_000),
                        leasedUntil: new Date(now - 600_000),
                    },
                    {
                        name: 'due',
                        status: 'PENDING',
                        state: 'DUE',
                        availableAt: new Date(now - 600_000),
                        leasedUntil: null,
                    },
                    {
                        name: 'scheduled',
                        status: 'PENDING',
                        state: 'SCHEDULED',
                        availableAt: new Date(now + 3_600_000),
                        leasedUntil: null,
                    },
                    {
                        name: 'leased',
                        status: 'PROCESSING',
                        state: 'LEASED',
                        availableAt: new Date(now - 600_000),
                        leasedUntil: new Date(now + 3_600_000),
                    },
                    {
                        name: 'expired',
                        status: 'PROCESSING',
                        state: 'EXPIRED',
                        availableAt: new Date(now - 600_000),
                        leasedUntil: new Date(now - 600_000),
                    },
                    {
                        name: 'missing lease',
                        status: 'PROCESSING',
                        state: 'EXPIRED',
                        availableAt: new Date(now - 600_000),
                        leasedUntil: null,
                    },
                ] as const;
                const expected = new Map<string, string>([
                    [invalid.version.id, 'FAILED'],
                ]);
                for (const state of states) {
                    const queued = await queueOperationsDocument(
                        `Ops states ${state.name}.txt`
                    );
                    expected.set(queued.version.id, state.state);
                    // Synthetic accepted claim/schedule fixture on an actual stored original;
                    // no processor, publication, content, reservation or completion is fabricated.
                    await prisma.documentIngestion.update({
                        where: { versionId: queued.version.id },
                        data: {
                            status: state.status,
                            availableAt: state.availableAt,
                            leasedUntil: state.leasedUntil,
                            leaseToken:
                                state.status === 'PROCESSING'
                                    ? randomUUID()
                                    : null,
                            attempts: state.status === 'PROCESSING' ? 1 : 0,
                        },
                    });
                }
                const beforeRows = await prisma.documentIngestion.findMany({
                    where: { organizationId: f.org },
                    orderBy: { versionId: 'asc' },
                });
                const beforeAudits = await prisma.ragAuditLog.count({
                    where: { organizationId: f.org },
                });
                const before = new Date();
                const snapshot = await f.owner.rag.operations.overview({
                    category: 'INGESTION',
                    query: 'Ops states',
                    limit: 100,
                });
                const after = new Date();
                assert(
                    snapshot.observedAt >= before &&
                        snapshot.observedAt <= after
                );
                assert.equal(snapshot.visibleTotal, 7);
                assert.equal(snapshot.items.length, 7);
                const counts = operationCounts(snapshot, 'INGESTION');
                assert.deepEqual(
                    {
                        uploading: counts.uploading,
                        due: counts.due,
                        scheduled: counts.scheduled,
                        leased: counts.leased,
                        expired: counts.expired,
                        failed: counts.failed,
                        total: counts.total,
                    },
                    {
                        uploading: 1,
                        due: 1,
                        scheduled: 1,
                        leased: 1,
                        expired: 2,
                        failed: 1,
                        total: 7,
                    }
                );
                assert(counts.oldestAcceptedAt instanceof Date);
                assert.equal(operationCounts(snapshot, 'INDEXING').total, 0);
                assert.equal(
                    operationCounts(snapshot, 'DOCUMENT_CLEANUP').total,
                    0
                );
                for (const row of snapshot.items) {
                    assert.equal(row.state, expected.get(row.id));
                    assert.equal(row.kind, 'INGESTION');
                    assert.equal(row.target.type, 'DOCUMENT');
                    assert.equal(row.target.deleted, false);
                    assert.equal(row.version, 1);
                    assert.equal('leaseToken' in row, false);
                    assert.equal('durationMs' in row, false);
                    assert.equal('workerHealthy' in row, false);
                }
                const filtered = await f.owner.rag.operations.overview({
                    category: 'INGESTION',
                    state: 'FAILED',
                    query: 'invalid',
                    limit: 1,
                });
                assert.deepEqual(
                    filtered.counts,
                    snapshot.counts,
                    'Organization totals must not change with selected-list filters.'
                );
                assert.equal(filtered.visibleTotal, 1);
                assert.equal(filtered.items[0]?.id, invalid.version.id);
                assert.ok(
                    isDeepStrictEqual(
                        await prisma.documentIngestion.findMany({
                            where: { organizationId: f.org },
                            orderBy: { versionId: 'asc' },
                        }),
                        beforeRows
                    ),
                    'Read-only operations must not retry, renew a lease or mutate durable work.'
                );
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: { organizationId: f.org },
                    }),
                    beforeAudits
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'retained failed ingestion history and raw diagnostics never become a current recovery target after a real replacement',
        async () => {
            const fixture = await createOperationsFixture('Current extraction');
            try {
                const invalid = await queueOperationsDocument(
                    'Current failed operations.txt',
                    new Uint8Array([0xff])
                );
                await processDocumentIngestions(prisma);
                const original = await f.owner.rag.operations.overview({
                    category: 'INGESTION',
                    state: 'FAILED',
                });
                assert.equal(original.items[0]?.id, invalid.version.id);
                assert.equal(original.items[0]?.errorCode, 'TEXT_INVALID');
                const raw =
                    'private provider https://hidden.test/?api_key=not-a-real-secret';
                await prisma.documentIngestion.update({
                    where: { versionId: invalid.version.id },
                    data: { errorCode: raw },
                });
                const safe = await f.owner.rag.operations.overview({
                    category: 'INGESTION',
                    state: 'FAILED',
                });
                assert.equal(safe.items[0]?.errorCode, 'PROCESSING_FAILED');
                assert.equal(JSON.stringify(safe).includes(raw), false);
                await f.owner.rag.documents.replace({
                    id: invalid.documentId,
                    expectedVersionId: invalid.version.id,
                    requestId: randomUUID(),
                    file: new File(
                        ['A valid replacement keeps exact current recovery.'],
                        'Current valid operations.txt'
                    ),
                    retentionDays: 1,
                });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: { versionId: invalid.version.id },
                        })
                    ).status,
                    'FAILED'
                );
                const current = await f.owner.rag.operations.overview({
                    category: 'INGESTION',
                });
                assert.equal(current.visibleTotal, 0);
                assert.equal(operationCounts(current, 'INGESTION').total, 0);
                const cleanup = await f.owner.rag.operations.overview({
                    category: 'DOCUMENT_CLEANUP',
                });
                assert.equal(cleanup.items[0]?.id, invalid.version.id);
                assert.equal(cleanup.items[0]?.state, 'SCHEDULED');
                assert.equal(cleanup.items[0]?.target.deleted, false);
                assert.equal(cleanup.items[0]?.version, 1);
            } finally {
                await fixture.close();
            }
        }
    );
}
