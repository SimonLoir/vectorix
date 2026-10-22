import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from '../mutation';
import { quotaLimits, quotaUsage } from '../quotas';
import { libraryWrite, requireDocument } from './access';
import { contentHash, uploadStorage } from './storage';
import { validateDocumentFile, transferOriginal } from './transfer';
import { scheduleVersionCleanup } from './retention';

/** Reserve an immutable replacement, preserving the last published original and all collection associations. */
export async function replaceDocument(
    context: AuthorizedContext,
    input: {
        id: string;
        expectedVersionId: string;
        requestId: string;
        file: File;
        retentionDays: number;
    }
) {
    validateDocumentFile(input.file);
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const sha256 = contentHash(bytes),
        versionId = randomUUID(),
        token = randomUUID();
    const accepted = await mutate(context, libraryWrite, async (db, actor) => {
        await requireDocument(db, actor, input.id);
        const replay = await db.documentIngestion.findUnique({
            where: {
                ['organizationId_requestId']: {
                    organizationId: actor.organizationId,
                    requestId: input.requestId,
                },
            },
            include: { version: true },
        });
        if (replay) {
            if (
                replay.version.documentId !== input.id ||
                replay.version.sha256 !== sha256 ||
                replay.version.fileName !== input.file.name ||
                replay.version.byteSize !== BigInt(bytes.length)
            )
                throw new ORPCError('CONFLICT');
            return { versionId: replay.versionId, transfer: null };
        }
        const latest = await db.documentVersion.findFirst({
            where: {
                organizationId: actor.organizationId,
                documentId: input.id,
            },
            orderBy: { version: 'desc' },
            include: { ingestion: true },
        });
        if (
            !latest ||
            latest.id !== input.expectedVersionId ||
            (latest.ingestion &&
                ['UPLOADING', 'PENDING', 'PROCESSING'].includes(
                    latest.ingestion.status
                ))
        )
            throw new ORPCError('CONFLICT', {
                message:
                    'The document changed or another replacement is still processing.',
            });
        const limits = await quotaLimits(db, actor.organizationId),
            usage = await quotaUsage(db, actor.organizationId);
        if (
            bytes.length > limits.originalBytes ||
            usage.storageBytes + 2 * bytes.length > limits.storageBytes
        )
            throw new ORPCError('CONFLICT', {
                message: 'The storage quota is exceeded.',
            });
        const storage = await uploadStorage(db, actor.organizationId);
        const key = `${actor.organizationId}/${input.id}/${versionId}/original`;
        await db.documentVersion.create({
            data: {
                id: versionId,
                organizationId: actor.organizationId,
                documentId: input.id,
                version: latest.version + 1,
                storageLocationId: storage.location.id,
                objectKey: key,
                sha256,
                byteSize: BigInt(bytes.length),
                fileName: input.file.name,
                mediaType: /\.txt$/i.test(input.file.name)
                    ? 'text/plain'
                    : 'text/markdown',
            },
        });
        await db.documentIngestion.create({
            data: {
                versionId,
                organizationId: actor.organizationId,
                requestId: input.requestId,
                requestedBy: actor.userId,
                reservedBytes: BigInt(bytes.length),
                leaseToken: token,
                leasedUntil: new Date(Date.now() + 300_000),
            },
        });
        await db.documentVersion.updateMany({
            where: {
                documentId: input.id,
                organizationId: actor.organizationId,
                fileName: null,
            },
            data: {
                fileName: (await requireDocument(db, actor, input.id)).name,
            },
        });
        const oldVersions = await db.documentVersion.findMany({
            where: {
                documentId: input.id,
                organizationId: actor.organizationId,
                id: { not: versionId },
                discardedAt: null,
            },
            select: { id: true },
        });
        const scheduledAt = new Date(
            Date.now() + input.retentionDays * 86_400_000
        );
        for (const old of oldVersions)
            await scheduleVersionCleanup(db, {
                organizationId: actor.organizationId,
                versionId: old.id,
                requestedBy: actor.userId,
                reason: 'REPLACED',
                scheduledAt,
            });
        await audit(db, actor, 'document.replacement.reserved', input.id, {
            versionId,
            previousVersionId: latest.id,
            retentionDays: input.retentionDays,
        });
        return { versionId, transfer: { config: storage.config, key } };
    });
    if (accepted.transfer)
        await transferOriginal(context, {
            documentId: input.id,
            versionId,
            token,
            bytes,
            ...accepted.transfer,
        });
    return { id: input.id, versionId: accepted.versionId };
}
