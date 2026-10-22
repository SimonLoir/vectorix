import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from '../mutation';
import { quotaLimits, quotaUsage } from '../quotas';
import { libraryWrite, requireDocument } from './access';

/** Retry only terminal failures, reusing retained storage reservations and current manager identity. */
export function retryDocument(context: AuthorizedContext, id: string) {
    return mutate(context, libraryWrite, async (db, actor) => {
        await requireDocument(db, actor, id);
        const version = await db.documentVersion.findFirst({
            where: { organizationId: actor.organizationId, documentId: id },
            orderBy: { version: 'desc' },
            include: { ingestion: true, document: true },
        });
        if (
            !version?.ingestion ||
            version.ingestion.status !== 'FAILED' ||
            version.discardedAt
        )
            throw new ORPCError('CONFLICT', {
                message:
                    'This upload cannot be retried. Upload the file again if its original is missing.',
            });
        const limits = await quotaLimits(db, actor.organizationId);
        const usage = await quotaUsage(db, actor.organizationId);
        if (
            usage.storageBytes +
                Number(version.byteSize - version.ingestion.reservedBytes) >
            limits.storageBytes
        )
            throw new ORPCError('CONFLICT', {
                message: 'The storage quota is exceeded.',
            });
        await db.documentIngestion.update({
            where: { versionId: version.id },
            data: {
                status: version.storedAt ? 'PENDING' : 'UPLOADING',
                requestedBy: actor.userId,
                attempts: 0,
                errorCode: null,
                reservedBytes: version.byteSize,
                availableAt: new Date(),
                leaseToken: null,
                leasedUntil: new Date(0),
            },
        });
        await db.documentVersion.update({
            where: { id: version.id },
            data: { status: 'PROCESSING' },
        });
        if (version.document.status !== 'READY')
            await db.document.update({
                where: { id },
                data: { status: 'PROCESSING' },
            });
        await audit(db, actor, 'document.extraction.retried', id, {
            versionId: version.id,
        });
        return { success: true as const };
    });
}
