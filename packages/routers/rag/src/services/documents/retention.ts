import type { Prisma, PrismaClient } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';

/** Longer than a bounded S3 operation; cleanup also waits out any pre-existing ingestion lease. */
export const OBJECT_IO_GRACE_MS = 60_000;

/** Schedule an immutable version for removal. Publication checks prevent retirement of the last readable version. */
export async function scheduleVersionCleanup(
    db: Prisma.TransactionClient,
    input: {
        organizationId: string;
        versionId: string;
        requestedBy: string;
        reason: 'REPLACED' | 'DELETED';
        scheduledAt: Date;
    }
) {
    const current = await db.documentCleanup.findUnique({
        where: { versionId: input.versionId },
    });
    if (current?.status === 'COMPLETE') return;
    const ingestion = await db.documentIngestion.findUnique({
        where: { versionId: input.versionId },
    });
    const availableAt = new Date(
        Math.max(
            input.scheduledAt.getTime(),
            (ingestion?.leasedUntil?.getTime() ?? 0) + OBJECT_IO_GRACE_MS
        )
    );
    await db.documentCleanup.upsert({
        where: { versionId: input.versionId },
        create: { ...input, availableAt },
        update: {
            reason: input.reason,
            requestedBy: input.requestedBy,
            scheduledAt: input.scheduledAt,
            availableAt,
            status: 'PENDING',
            attempts: 0,
            errorCode: null,
            leaseToken: null,
            leasedUntil: null,
        },
    });
}

/** A PUT that lost publication authority must still be reconciled, including after a delayed network completion. */
export async function reconcileUnpublishedWrite(
    db: PrismaClient,
    versionId: string
) {
    await runSerializableTransaction(db, async (tx) => {
        const version = await tx.documentVersion.findUnique({
            where: { id: versionId },
            include: { document: true, cleanup: true },
        });
        if (!version) return;
        const latest = await tx.documentVersion.findFirst({
            where: {
                documentId: version.documentId,
                organizationId: version.organizationId,
            },
            orderBy: { version: 'desc' },
            select: { id: true },
        });
        if (
            !version.cleanup &&
            !version.document.deletedAt &&
            latest?.id === versionId
        )
            return;
        const availableAt = new Date(
            Math.max(
                Date.now() + OBJECT_IO_GRACE_MS,
                version.cleanup?.scheduledAt.getTime() ?? 0
            )
        );
        await tx.documentCleanup.upsert({
            where: { versionId },
            create: {
                versionId,
                organizationId: version.organizationId,
                requestedBy: 'late-writer',
                reason: version.document.deletedAt ? 'DELETED' : 'REPLACED',
                scheduledAt: availableAt,
                availableAt,
            },
            update: {
                status: 'PENDING',
                availableAt,
                attempts: 0,
                errorCode: null,
                completedAt: null,
                leaseToken: null,
                leasedUntil: null,
            },
        });
        if (version.cleanup?.status === 'COMPLETE')
            await tx.documentIngestion.updateMany({
                where: { versionId },
                data: { reservedBytes: version.byteSize },
            });
        await tx.documentVersion.update({
            where: { id: versionId },
            data: { discardedAt: null },
        });
    });
}
