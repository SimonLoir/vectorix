import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { putObject } from '@repo/storage';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { mutate, audit } from '../mutation';
import { quotaLimits, quotaUsage } from '../quotas';
import { libraryWrite } from './access';
import { contentHash, uploadStorage } from './storage';

/** Reserve both objects before S3 I/O. A lost response can replay the same request ID without creating another document. */
export async function uploadDocument(
    context: AuthorizedContext,
    input: { requestId: string; file: File }
) {
    const file = input.file;
    if (
        !/\.(txt|md|markdown)$/i.test(file.name) ||
        [...file.name].some(
            (character) =>
                character.codePointAt(0)! < 32 ||
                character.codePointAt(0)! === 127 ||
                character === '/' ||
                character === '\\'
        ) ||
        file.name.length > 200 ||
        !file.size ||
        file.size > MAX_DOCUMENT_BYTES
    )
        throw new ORPCError('BAD_REQUEST', {
            message:
                'Upload a non-empty TXT or Markdown file of at most 25 MiB with a valid filename.',
        });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = contentHash(bytes);
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
                existing.version.document.name !== file.name ||
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
            usage.storageBytes + 2 * bytes.length > limits.storageBytes
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
                mediaType: /\.txt$/i.test(file.name)
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
    if (accepted.transfer) {
        try {
            await putObject(
                accepted.transfer.config,
                accepted.transfer.key,
                bytes,
                sha256,
                'application/octet-stream'
            );
        } catch {
            // Keep the reservation until the worker proves the write absent or recovers it after the upload lease expires.
            await context.db.documentIngestion.updateMany({
                where: { versionId, leaseToken: token },
                data: { errorCode: 'STORAGE_UNAVAILABLE' },
            });
            return { id: accepted.id, versionId: accepted.versionId };
        }
        await mutate(context, libraryWrite, async (db, actor) => {
            const changed = await db.documentIngestion.updateMany({
                where: {
                    versionId,
                    organizationId: actor.organizationId,
                    status: 'UPLOADING',
                    leaseToken: token,
                },
                data: {
                    status: 'PENDING',
                    leasedUntil: null,
                    leaseToken: null,
                    availableAt: new Date(),
                    errorCode: null,
                },
            });
            if (!changed.count) return;
            await db.documentVersion.update({
                where: { id: versionId },
                data: { storedAt: new Date(), status: 'PROCESSING' },
            });
            await db.document.update({
                where: { id: documentId },
                data: { status: 'PROCESSING' },
            });
            await audit(db, actor, 'document.upload.stored', documentId, {
                versionId,
            });
        });
    }
    return { id: accepted.id, versionId: accepted.versionId };
}
