import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { permits } from '@repo/auth/permissions';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    headObject,
    readObject,
    putObject,
    deleteObject,
    StorageError,
} from '@repo/storage';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { boundStorage, contentHash } from './storage';
import { libraryWrite } from './access';
import { extractText, TextExtractionError } from './extract';

const LEASE_MS = 180_000;
const RETRIES = 5;
/** The queue carries no document body or credentials: PostgreSQL owns claims, retries, and terminal state. */
export async function processDocumentIngestions(db: PrismaClient) {
    const now = new Date();
    const eligible = {
        availableAt: { lte: now },
        OR: [
            { status: 'PENDING' as const },
            {
                status: { in: ['UPLOADING' as const, 'PROCESSING' as const] },
                leasedUntil: { lte: now },
            },
        ],
    };
    const tasks = await db.documentIngestion.findMany({
        where: eligible,
        orderBy: [{ availableAt: 'asc' }, { versionId: 'asc' }],
        take: 10,
        select: { versionId: true, status: true },
    });
    for (const task of tasks) {
        const token = randomUUID();
        const claimed = await db.documentIngestion.updateMany({
            where: {
                ...eligible,
                versionId: task.versionId,
                status: task.status,
            },
            data: {
                status:
                    task.status === 'UPLOADING' ? 'UPLOADING' : 'PROCESSING',
                leaseToken: token,
                leasedUntil: new Date(Date.now() + LEASE_MS),
                attempts: { increment: 1 },
            },
        });
        if (!claimed.count) continue;
        await processClaim(db, task.versionId, token);
    }
}

/** S3 writes are deterministic; a reclaimed worker cannot publish after losing its lease. */
async function processClaim(
    db: PrismaClient,
    versionId: string,
    token: string
) {
    const task = await db.documentIngestion.findUniqueOrThrow({
        where: { versionId },
        include: {
            version: {
                include: {
                    document: {
                        include: {
                            organization: { select: { isActive: true } },
                        },
                    },
                },
            },
        },
    });
    const version = task.version;
    try {
        const membership = await getMemberPermissions(
            task.organizationId,
            task.requestedBy,
            db
        );
        if (
            !version.document.organization.isActive ||
            version.document.deletedAt ||
            !membership ||
            !permits(membership.permissions, libraryWrite)
        )
            throw new TextExtractionError('ACCESS_REVOKED');
        const config = await boundStorage(
            db,
            task.organizationId,
            version.storageLocationId
        );
        if (!version.storedAt) {
            const object = await headObject(config, version.objectKey);
            if (
                !object ||
                object.byteSize !== Number(version.byteSize) ||
                object.sha256 !== version.sha256
            ) {
                if (object) await deleteObject(config, version.objectKey);
                await runSerializableTransaction(db, async (tx) => {
                    const held = await tx.documentIngestion.updateMany({
                        where: {
                            versionId,
                            leaseToken: token,
                            leasedUntil: { gt: new Date() },
                        },
                        data: {
                            status: 'FAILED',
                            errorCode: 'UPLOAD_INCOMPLETE',
                            reservedBytes: 0n,
                            leaseToken: null,
                            leasedUntil: null,
                        },
                    });
                    if (!held.count) return;
                    await tx.documentVersion.update({
                        where: { id: versionId },
                        data: { status: 'FAILED', discardedAt: new Date() },
                    });
                    await tx.document.update({
                        where: { id: version.documentId },
                        data: { status: 'FAILED' },
                    });
                });
                return;
            }
            const recovered = await runSerializableTransaction(
                db,
                async (tx) => {
                    const held = await tx.documentIngestion.updateMany({
                        where: {
                            versionId,
                            leaseToken: token,
                            leasedUntil: { gt: new Date() },
                        },
                        data: { status: 'PROCESSING' },
                    });
                    if (!held.count) return false;
                    await tx.documentVersion.update({
                        where: { id: versionId },
                        data: { storedAt: new Date() },
                    });
                    return true;
                }
            );
            if (!recovered) return;
        }
        const original = await readObject(
            config,
            version.objectKey,
            MAX_DOCUMENT_BYTES
        );
        const text = extractText(original, version.sha256);
        if (text.length > Number(task.reservedBytes))
            throw new TextExtractionError('TEXT_INVALID');
        const key = `${task.organizationId}/${version.documentId}/${versionId}/text.txt`;
        await putObject(
            config,
            key,
            text,
            contentHash(text),
            'text/plain; charset=utf-8'
        );
        await runSerializableTransaction(db, async (tx) => {
            const currentMembership = await getMemberPermissions(
                task.organizationId,
                task.requestedBy,
                tx
            );
            const active = await tx.document.findFirst({
                where: {
                    id: version.documentId,
                    organizationId: task.organizationId,
                    deletedAt: null,
                    organization: { isActive: true },
                },
            });
            if (
                !active ||
                !currentMembership ||
                !permits(currentMembership.permissions, libraryWrite)
            )
                throw new TextExtractionError('ACCESS_REVOKED');
            const held = await tx.documentIngestion.updateMany({
                where: {
                    versionId,
                    leaseToken: token,
                    leasedUntil: { gt: new Date() },
                },
                data: {
                    status: 'READY',
                    reservedBytes: 0n,
                    leaseToken: null,
                    leasedUntil: null,
                    errorCode: null,
                },
            });
            if (!held.count) return;
            await tx.documentExtraction.upsert({
                where: { versionId },
                create: {
                    organizationId: task.organizationId,
                    versionId,
                    storageLocationId: version.storageLocationId,
                    objectKey: key,
                    byteSize: BigInt(text.length),
                    extractorVersion: 'utf8-text-v1',
                    language: 'und',
                },
                update: {},
            });
            await tx.documentVersion.update({
                where: { id: versionId },
                data: { status: 'READY' },
            });
            await tx.document.update({
                where: { id: version.documentId },
                data: { status: 'READY' },
            });
            await tx.ragAuditLog.create({
                data: {
                    organizationId: task.organizationId,
                    actorType: 'worker',
                    actorId: 'document-ingestion',
                    action: 'document.extraction.ready',
                    targetId: version.documentId,
                    details: { versionId, bytes: text.length },
                },
            });
        });
    } catch (error) {
        const code =
            error instanceof TextExtractionError
                ? error.code
                : error instanceof StorageError
                  ? 'STORAGE_UNAVAILABLE'
                  : 'PROCESSING_FAILED';
        const terminal =
            error instanceof TextExtractionError || task.attempts >= RETRIES;
        const delay = new Date(
            Date.now() + Math.min(300_000, 10_000 * 2 ** task.attempts)
        );
        await runSerializableTransaction(db, async (tx) => {
            const latest = await tx.documentVersion.findUnique({
                where: { id: versionId },
                select: { storedAt: true },
            });
            // Retain capacity for a potentially written extraction until retry publishes it.
            // Releasing it here would undercount an interrupted S3 write outside the transaction.
            const held = await tx.documentIngestion.updateMany({
                where: {
                    versionId,
                    leaseToken: token,
                    leasedUntil: { gt: new Date() },
                },
                data: {
                    status: terminal
                        ? 'FAILED'
                        : latest?.storedAt
                          ? 'PENDING'
                          : 'UPLOADING',
                    errorCode: code,
                    leaseToken: null,
                    leasedUntil: terminal ? null : delay,
                    availableAt: delay,
                },
            });
            if (!held.count) return;
            if (terminal) {
                await tx.documentVersion.update({
                    where: { id: versionId },
                    data: { status: 'FAILED' },
                });
                await tx.document.update({
                    where: { id: version.documentId },
                    data: { status: 'FAILED' },
                });
            }
        });
    }
}
