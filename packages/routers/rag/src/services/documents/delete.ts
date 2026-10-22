import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from '../mutation';
import { libraryWrite } from './access';
import { scheduleVersionCleanup } from './retention';

/** Tombstones and link removal take effect immediately; private object deletion is durable and independent of membership. */
export function deleteDocument(
    context: AuthorizedContext,
    input: { id: string; expectedVersionId: string; retentionDays: number }
) {
    return mutate(context, libraryWrite, async (db, actor) => {
        const document = await db.document.findFirst({
            where: { id: input.id, organizationId: actor.organizationId },
        });
        if (!document) throw new ORPCError('NOT_FOUND');
        const latest = await db.documentVersion.findFirst({
            where: {
                organizationId: actor.organizationId,
                documentId: input.id,
            },
            orderBy: { version: 'desc' },
        });
        if (!latest || latest.id !== input.expectedVersionId)
            throw new ORPCError('CONFLICT', {
                message: 'The document changed. Reload before deleting it.',
            });
        if (document.deletedAt) return { success: true as const };
        const deletedAt = new Date(),
            scheduledAt = new Date(
                deletedAt.getTime() + input.retentionDays * 86_400_000
            );
        await db.document.update({
            where: { id: input.id },
            data: { deletedAt, status: 'DELETED' },
        });
        await db.collectionDocument.deleteMany({
            where: {
                organizationId: actor.organizationId,
                documentId: input.id,
            },
        });
        const versions = await db.documentVersion.findMany({
            where: {
                organizationId: actor.organizationId,
                documentId: input.id,
                discardedAt: null,
            },
            select: { id: true },
        });
        for (const version of versions)
            await scheduleVersionCleanup(db, {
                organizationId: actor.organizationId,
                versionId: version.id,
                requestedBy: actor.userId,
                reason: 'DELETED',
                scheduledAt,
            });
        // Preserve old lease deadlines for cleanup's I/O safety window, but revoke publication authority now.
        await db.documentIngestion.updateMany({
            where: {
                organizationId: actor.organizationId,
                version: { documentId: input.id },
            },
            data: {
                status: 'FAILED',
                errorCode: 'ACCESS_REVOKED',
                leaseToken: null,
            },
        });
        await db.documentVersion.updateMany({
            where: {
                organizationId: actor.organizationId,
                documentId: input.id,
            },
            data: { status: 'DELETED' },
        });
        await audit(db, actor, 'document.deleted', input.id, {
            retentionDays: input.retentionDays,
            versions: versions.length,
        });
        return { success: true as const };
    });
}
