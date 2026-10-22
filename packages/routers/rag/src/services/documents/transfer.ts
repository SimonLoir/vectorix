import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { putObject, type S3Configuration } from '@repo/storage';
import { mediaTypeForFile } from '@repo/documents';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { mutate, audit } from '../mutation';
import { libraryWrite } from './access';
import { contentHash } from './storage';
import { reconcileUnpublishedWrite } from './retention';

/** Reject unsupported or unsafe names before reserving quota or creating storage objects. */
export function validateDocumentFile(file: File) {
    if (
        !mediaTypeForFile(file.name) ||
        [...file.name].some(
            (c) =>
                c.codePointAt(0)! < 32 ||
                c.codePointAt(0)! === 127 ||
                c === '/' ||
                c === '\\'
        ) ||
        file.name.length > 200 ||
        !file.size ||
        file.size > MAX_DOCUMENT_BYTES
    )
        throw new ORPCError('BAD_REQUEST', {
            message:
                'Upload a non-empty TXT, Markdown, PDF or DOCX file of at most 25 MiB with a valid filename.',
        });
}

/** Recheck the lease before I/O; publication is fenced and rejected writes are durably reconciled. */
export async function transferOriginal(
    context: AuthorizedContext,
    input: {
        documentId: string;
        versionId: string;
        token: string;
        bytes: Uint8Array;
        config: S3Configuration;
        key: string;
    }
) {
    const held = await context.db.documentIngestion.findFirst({
        where: {
            versionId: input.versionId,
            leaseToken: input.token,
            leasedUntil: { gt: new Date() },
            version: { document: { deletedAt: null } },
        },
    });
    if (!held) return;
    try {
        await putObject(
            input.config,
            input.key,
            input.bytes,
            contentHash(input.bytes),
            'application/octet-stream'
        );
    } catch {
        await context.db.documentIngestion.updateMany({
            where: { versionId: input.versionId, leaseToken: input.token },
            data: { errorCode: 'STORAGE_UNAVAILABLE' },
        });
        // A timed-out PUT may still have reached storage; retain the reservation and reconcile it.
        await reconcileUnpublishedWrite(context.db, input.versionId);
        return;
    }
    let published = false;
    try {
        published = await mutate(context, libraryWrite, async (db, actor) => {
            const document = await db.document.findFirst({
                where: {
                    id: input.documentId,
                    organizationId: actor.organizationId,
                    deletedAt: null,
                },
            });
            if (!document) return false;
            const latest = await db.documentVersion.findFirst({
                where: {
                    documentId: input.documentId,
                    organizationId: actor.organizationId,
                },
                orderBy: { version: 'desc' },
            });
            if (latest?.id !== input.versionId) return false;
            const changed = await db.documentIngestion.updateMany({
                where: {
                    versionId: input.versionId,
                    organizationId: actor.organizationId,
                    status: 'UPLOADING',
                    leaseToken: input.token,
                    leasedUntil: { gt: new Date() },
                },
                data: {
                    status: 'PENDING',
                    leaseToken: null,
                    leasedUntil: null,
                    availableAt: new Date(),
                    errorCode: null,
                },
            });
            if (!changed.count) return false;
            await db.documentVersion.update({
                where: { id: input.versionId },
                data: { storedAt: new Date(), status: 'PROCESSING' },
            });
            if (document.status !== 'READY')
                await db.document.update({
                    where: { id: input.documentId },
                    data: { status: 'PROCESSING' },
                });
            await audit(db, actor, 'document.upload.stored', input.documentId, {
                versionId: input.versionId,
            });
            return true;
        });
    } finally {
        if (!published)
            await reconcileUnpublishedWrite(context.db, input.versionId);
    }
}
