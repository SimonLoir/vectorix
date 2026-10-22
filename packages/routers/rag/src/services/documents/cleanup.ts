import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { deleteObject, StorageError } from '@repo/storage';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { boundStorage } from './storage';
import { OBJECT_IO_GRACE_MS } from './retention';

const LEASE_MS = 180_000;
/** Authorized deletion/retirement survives worker restarts, organization suspension and requester removal. */
export async function processDocumentCleanups(db: PrismaClient) {
    const eligible = {
        availableAt: { lte: new Date() },
        OR: [
            { status: 'PENDING' as const },
            { status: 'PROCESSING' as const, leasedUntil: { lte: new Date() } },
        ],
    };
    const tasks = await db.documentCleanup.findMany({
        where: eligible,
        orderBy: [{ availableAt: 'asc' }, { versionId: 'asc' }],
        take: 10,
        select: { versionId: true },
    });
    for (const task of tasks) {
        const token = randomUUID();
        const claimed = await db.documentCleanup.updateMany({
            where: { ...eligible, versionId: task.versionId },
            data: {
                status: 'PROCESSING',
                leaseToken: token,
                leasedUntil: new Date(Date.now() + LEASE_MS),
            },
        });
        if (claimed.count) await cleanVersion(db, task.versionId, token);
    }
}

/** Delete every possible object before releasing any bytes. Token checks fence PostgreSQL completion after retries. */
async function cleanVersion(
    db: PrismaClient,
    versionId: string,
    token: string
) {
    // A hold and a destructive claim both write the same version fence inside a
    // serializable transaction. The state transition commits before any S3 DELETE,
    // so a later index worker cannot promise to retain an object already in flight.
    const task = await runSerializableTransaction(db, async (tx) => {
        const now = new Date();
        const candidate = await tx.documentCleanup.findFirst({
            where: {
                versionId,
                status: 'PROCESSING',
                leaseToken: token,
                leasedUntil: { gt: now },
            },
            include: {
                version: {
                    include: {
                        document: true,
                        ingestion: true,
                        extraction: true,
                    },
                },
            },
        });
        if (!candidate) return null;
        const version = candidate.version;
        const fenced = await tx.documentVersion.updateMany({
            where: {
                id: versionId,
                organizationId: candidate.organizationId,
                contentFence: version.contentFence,
            },
            data: { contentFence: { increment: 1 } },
        });
        if (!fenced.count) return null;
        const [published, latest, holds] = await Promise.all([
            tx.documentVersion.findFirst({
                where: {
                    organizationId: candidate.organizationId,
                    documentId: version.documentId,
                    status: 'READY',
                    contentState: 'AVAILABLE',
                    discardedAt: null,
                },
                orderBy: { version: 'desc' },
                select: { id: true },
            }),
            tx.documentVersion.findFirst({
                where: {
                    organizationId: candidate.organizationId,
                    documentId: version.documentId,
                },
                orderBy: { version: 'desc' },
                select: { id: true },
            }),
            tx.documentSourceHold.findMany({
                where: {
                    organizationId: candidate.organizationId,
                    versionId,
                    OR: [
                        { state: 'LIVE' },
                        { state: 'RETIRED', retainUntil: { gt: now } },
                    ],
                },
                select: { retainUntil: true },
            }),
        ]);
        const ioDeadline =
            (version.ingestion?.leasedUntil?.getTime() ?? 0) +
            OBJECT_IO_GRACE_MS;
        if (
            (version.contentState === 'AVAILABLE' &&
                !version.document.deletedAt &&
                (published?.id === versionId || latest?.id === versionId)) ||
            candidate.scheduledAt > now ||
            ioDeadline > now.getTime() ||
            holds.length
        ) {
            await tx.documentCleanup.updateMany({
                where: { versionId, leaseToken: token },
                data: {
                    status: 'PENDING',
                    leaseToken: null,
                    leasedUntil: null,
                    availableAt: new Date(
                        Math.max(
                            now.getTime() + 30_000,
                            candidate.scheduledAt.getTime(),
                            ioDeadline,
                            ...holds.map(
                                (hold) => hold.retainUntil?.getTime() ?? 0
                            )
                        )
                    ),
                },
            });
            return null;
        }
        await tx.documentVersion.update({
            where: { id: versionId },
            data: {
                // A delayed PUT may require another physical purge; never revive
                // a previously purged source while reconciling that orphan.
                contentState:
                    version.contentState === 'PURGED' ? 'PURGED' : 'DELETING',
            },
        });
        await tx.documentCleanup.update({
            where: { versionId },
            data: { attempts: { increment: 1 } },
        });
        return candidate;
    });
    if (!task) return;
    const version = task.version;
    try {
        const config = await boundStorage(
            db,
            task.organizationId,
            version.storageLocationId
        );
        await deleteObject(config, version.objectKey);
        const textKey = `${task.organizationId}/${version.documentId}/${versionId}/text.txt`;
        await deleteObject(config, textKey);
        await deleteObject(
            config,
            `${task.organizationId}/${version.documentId}/${versionId}/extraction.json`
        );
        if (
            version.extraction &&
            (version.extraction.objectKey !== textKey ||
                version.extraction.storageLocationId !==
                    version.storageLocationId)
        ) {
            await deleteObject(
                await boundStorage(
                    db,
                    task.organizationId,
                    version.extraction.storageLocationId
                ),
                version.extraction.objectKey
            );
        }
        await runSerializableTransaction(db, async (tx) => {
            const held = await tx.documentCleanup.updateMany({
                where: {
                    versionId,
                    leaseToken: token,
                    leasedUntil: { gt: new Date() },
                },
                data: {
                    status: 'COMPLETE',
                    completedAt: new Date(),
                    leaseToken: null,
                    leasedUntil: null,
                    errorCode: null,
                },
            });
            if (!held.count) return;
            await tx.documentExtraction.updateMany({
                where: { organizationId: task.organizationId, versionId },
                data: { discardedAt: new Date() },
            });
            await tx.documentIngestion.updateMany({
                where: { versionId },
                data: {
                    reservedBytes: 0n,
                    leaseToken: null,
                    leasedUntil: null,
                },
            });
            await tx.documentVersion.update({
                where: { id: versionId },
                data: {
                    discardedAt: new Date(),
                    contentState: 'PURGED',
                    contentFence: { increment: 1 },
                },
            });
            await tx.ragAuditLog.create({
                data: {
                    organizationId: task.organizationId,
                    actorType: 'worker',
                    actorId: 'document-cleanup',
                    action: 'document.cleanup.complete',
                    targetId: version.documentId,
                    details: { versionId },
                },
            });
        });
    } catch (error) {
        const terminal = task.attempts + 1 >= 5;
        await db.documentCleanup.updateMany({
            where: {
                versionId,
                leaseToken: token,
                leasedUntil: { gt: new Date() },
            },
            data: {
                status: terminal ? 'FAILED' : 'PENDING',
                errorCode:
                    error instanceof StorageError
                        ? 'STORAGE_UNAVAILABLE'
                        : 'CLEANUP_FAILED',
                availableAt: new Date(
                    Date.now() +
                        Math.min(300_000, 10_000 * 2 ** (task.attempts + 1))
                ),
                leaseToken: null,
                leasedUntil: null,
            },
        });
    }
}
