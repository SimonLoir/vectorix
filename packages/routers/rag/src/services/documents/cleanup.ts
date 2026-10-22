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
    const task = await db.documentCleanup.findUniqueOrThrow({
        where: { versionId },
        include: {
            version: {
                include: { document: true, ingestion: true, extraction: true },
            },
        },
    });
    const version = task.version;
    const published = await db.documentVersion.findFirst({
        where: {
            organizationId: task.organizationId,
            documentId: version.documentId,
            status: 'READY',
            discardedAt: null,
        },
        orderBy: { version: 'desc' },
        select: { id: true },
    });
    const latest = await db.documentVersion.findFirst({
        where: {
            organizationId: task.organizationId,
            documentId: version.documentId,
        },
        orderBy: { version: 'desc' },
        select: { id: true },
    });
    const ioDeadline =
        (version.ingestion?.leasedUntil?.getTime() ?? 0) + OBJECT_IO_GRACE_MS;
    if (
        (!version.document.deletedAt &&
            (published?.id === versionId || latest?.id === versionId)) ||
        task.scheduledAt.getTime() > Date.now() ||
        ioDeadline > Date.now()
    ) {
        await db.documentCleanup.updateMany({
            where: { versionId, leaseToken: token },
            data: {
                status: 'PENDING',
                leaseToken: null,
                leasedUntil: null,
                availableAt: new Date(
                    Math.max(
                        Date.now() + 30_000,
                        task.scheduledAt.getTime(),
                        ioDeadline
                    )
                ),
            },
        });
        return;
    }
    try {
        const attempt = await db.documentCleanup.updateMany({
            where: {
                versionId,
                leaseToken: token,
                leasedUntil: { gt: new Date() },
            },
            data: { attempts: { increment: 1 } },
        });
        if (!attempt.count) return;
        const config = await boundStorage(
            db,
            task.organizationId,
            version.storageLocationId
        );
        await deleteObject(config, version.objectKey);
        const textKey = `${task.organizationId}/${version.documentId}/${versionId}/text.txt`;
        await deleteObject(config, textKey);
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
            await tx.documentExtraction.deleteMany({
                where: { organizationId: task.organizationId, versionId },
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
                data: { discardedAt: new Date() },
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
