import type { Prisma, PrismaClient } from '@repo/db';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { permits } from '@repo/auth/permissions';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { libraryWrite } from './access';

/** Only the current live attempt may perform new external writes. */
export async function ingestionMayWrite(
    db: Prisma.TransactionClient,
    versionId: string,
    token: string
) {
    const held = await db.documentIngestion.findFirst({
        where: {
            versionId,
            leaseToken: token,
            leasedUntil: { gt: new Date() },
            version: {
                discardedAt: null,
                document: { deletedAt: null, organization: { isActive: true } },
            },
        },
        include: { version: true },
    });
    if (!held) return false;
    const latest = await db.documentVersion.findFirst({
        where: {
            organizationId: held.organizationId,
            documentId: held.version.documentId,
        },
        orderBy: { version: 'desc' },
        select: { id: true },
    });
    return latest?.id === versionId;
}

/** Publish in one transaction; a failed replacement leaves the previous ready version readable. */
export function publishExtraction(
    db: PrismaClient,
    input: {
        versionId: string;
        token: string;
        key: string;
        byteSize: number;
        extractorVersion?: string;
    }
) {
    return runSerializableTransaction(db, async (tx) => {
        if (!(await ingestionMayWrite(tx, input.versionId, input.token)))
            return false;
        const task = await tx.documentIngestion.findUniqueOrThrow({
            where: { versionId: input.versionId },
            include: { version: { include: { document: true } } },
        });
        const member = await getMemberPermissions(
            task.organizationId,
            task.requestedBy,
            tx
        );
        if (!member || !permits(member.permissions, libraryWrite)) return false;
        await tx.documentIngestion.update({
            where: { versionId: input.versionId },
            data: {
                status: 'READY',
                reservedBytes: 0n,
                leaseToken: null,
                leasedUntil: null,
                errorCode: null,
            },
        });
        await tx.documentExtraction.upsert({
            where: { versionId: input.versionId },
            create: {
                organizationId: task.organizationId,
                versionId: input.versionId,
                storageLocationId: task.version.storageLocationId,
                objectKey: input.key,
                byteSize: BigInt(input.byteSize),
                extractorVersion: input.extractorVersion ?? 'utf8-text-v1',
                language: 'und',
            },
            update: {},
        });
        await tx.documentVersion.update({
            where: { id: input.versionId },
            data: { status: 'READY' },
        });
        await tx.document.update({
            where: { id: task.version.documentId },
            data: {
                status: 'READY',
                name: task.version.fileName ?? task.version.document.name,
            },
        });
        await tx.ragAuditLog.create({
            data: {
                organizationId: task.organizationId,
                actorType: 'worker',
                actorId: 'document-ingestion',
                action: 'document.extraction.ready',
                targetId: task.version.documentId,
                details: { versionId: input.versionId, bytes: input.byteSize },
            },
        });
        return true;
    });
}

/** Failure state is fenced and never overwrites a tombstone, a newer attempt, or an existing publication. */
export function recordIngestionFailure(
    db: PrismaClient,
    input: {
        versionId: string;
        token: string;
        code: string;
        terminal: boolean;
        delay: Date;
        discard?: boolean;
    }
) {
    return runSerializableTransaction(db, async (tx) => {
        const version = await tx.documentVersion.findUnique({
            where: { id: input.versionId },
            include: { document: true },
        });
        if (!version) return;
        const held = await tx.documentIngestion.updateMany({
            where: {
                versionId: input.versionId,
                leaseToken: input.token,
                leasedUntil: { gt: new Date() },
            },
            data: {
                status: input.terminal
                    ? 'FAILED'
                    : version.storedAt
                      ? 'PENDING'
                      : 'UPLOADING',
                errorCode: input.code,
                reservedBytes: input.discard ? 0n : undefined,
                leaseToken: null,
                leasedUntil: input.terminal ? null : input.delay,
                availableAt: input.delay,
            },
        });
        if (!held.count || !input.terminal) return;
        await tx.documentVersion.update({
            where: { id: input.versionId },
            data: {
                status: version.document.deletedAt ? 'DELETED' : 'FAILED',
                discardedAt: input.discard ? new Date() : undefined,
            },
        });
        const latest = await tx.documentVersion.findFirst({
            where: {
                organizationId: version.organizationId,
                documentId: version.documentId,
            },
            orderBy: { version: 'desc' },
            select: { id: true },
        });
        const published = await tx.documentVersion.count({
            where: {
                organizationId: version.organizationId,
                documentId: version.documentId,
                status: 'READY',
                discardedAt: null,
            },
        });
        if (
            !version.document.deletedAt &&
            latest?.id === input.versionId &&
            !published
        )
            await tx.document.update({
                where: { id: version.documentId },
                data: { status: 'FAILED' },
            });
    });
}
