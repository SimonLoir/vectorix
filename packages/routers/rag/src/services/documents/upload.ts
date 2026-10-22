import { mediaTypeForFile, extractionReservation } from '@repo/documents';
import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from '../mutation';
import { quotaLimits, quotaUsage } from '../quotas';
import { libraryWrite } from './access';
import { contentHash, uploadStorage } from './storage';
import { validateDocumentFile, transferOriginal } from './transfer';

/** Reserve both objects before S3 I/O. A lost response can replay the same request ID without creating another document. */
export async function uploadDocument(
    context: AuthorizedContext,
    input: { requestId: string; file: File }
) {
    const file = input.file;
    validateDocumentFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = contentHash(bytes);
    const mediaType = mediaTypeForFile(file.name)!;
    const reservation = extractionReservation(mediaType, bytes.length);
    const documentId = randomUUID(),
        versionId = randomUUID(),
        token = randomUUID();
    const accepted = await mutate(context, libraryWrite, async (db, actor) => {
        const existing = await db.documentIngestion.findUnique({
            where: {
                ['organizationId_requestId']: {
                    organizationId: actor.organizationId,
                    requestId: input.requestId,
                },
            },
            include: { version: { include: { document: true } } },
        });
        if (existing) {
            if (
                existing.version.sha256 !== sha256 ||
                (existing.version.fileName ??
                    existing.version.document.name) !== file.name ||
                existing.version.byteSize !== BigInt(bytes.length) ||
                existing.version.document.deletedAt
            )
                throw new ORPCError('CONFLICT', {
                    message:
                        'This upload request ID is already bound to another file.',
                });
            return {
                id: existing.version.documentId,
                versionId: existing.versionId,
                transfer: null,
            };
        }
        const limits = await quotaLimits(db, actor.organizationId);
        const usage = await quotaUsage(db, actor.organizationId);
        if (
            bytes.length > limits.originalBytes ||
            usage.documents >= limits.documents ||
            BigInt(usage.storageBytes) + BigInt(bytes.length) + reservation >
                BigInt(limits.storageBytes)
        )
            throw new ORPCError('CONFLICT', {
                message: 'The document or storage quota is exceeded.',
            });
        const storage = await uploadStorage(db, actor.organizationId);
        const key = `${actor.organizationId}/${documentId}/${versionId}/original`;
        await db.document.create({
            data: {
                id: documentId,
                organizationId: actor.organizationId,
                name: file.name,
            },
        });
        await db.documentVersion.create({
            data: {
                id: versionId,
                organizationId: actor.organizationId,
                documentId,
                version: 1,
                storageLocationId: storage.location.id,
                objectKey: key,
                sha256,
                byteSize: BigInt(bytes.length),
                fileName: file.name,
                mediaType,
            },
        });
        await db.documentIngestion.create({
            data: {
                versionId,
                organizationId: actor.organizationId,
                requestId: input.requestId,
                requestedBy: actor.userId,
                reservedBytes: reservation,
                leaseToken: token,
                leasedUntil: new Date(Date.now() + 300_000),
            },
        });
        await audit(db, actor, 'document.upload.reserved', documentId, {
            versionId,
            bytes: bytes.length,
        });
        return {
            id: documentId,
            versionId,
            transfer: { config: storage.config, key },
        };
    });
    if (accepted.transfer)
        await transferOriginal(context, {
            documentId,
            versionId,
            token,
            bytes,
            ...accepted.transfer,
        });
    return { id: accepted.id, versionId: accepted.versionId };
}
