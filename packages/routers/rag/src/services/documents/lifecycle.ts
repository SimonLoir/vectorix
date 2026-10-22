import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { documentLifecycle } from '@repo/api-contracts/v1/rag/documents';
import { ragActor } from '../access';
import { mutate, audit } from '../mutation';
import { libraryWrite } from './access';

/** Manager-only retained metadata, bounded independently of the published-content read paths. */
export async function getDocumentLifecycle(
    context: AuthorizedContext,
    input: { id: string; offset: number; limit: number }
) {
    const actor = await ragActor(context, context.db, libraryWrite, true);
    const document = await context.db.document.findFirst({
        where: { organizationId: actor.organizationId, id: input.id },
    });
    if (!document) throw new ORPCError('NOT_FOUND');
    const where = {
        organizationId: actor.organizationId,
        documentId: input.id,
    };
    const [versions, total, published, latest] = await Promise.all([
        context.db.documentVersion.findMany({
            where,
            orderBy: { version: 'desc' },
            skip: input.offset,
            take: input.limit,
            include: { ingestion: true, cleanup: true },
        }),
        context.db.documentVersion.count({ where }),
        context.db.documentVersion.findFirst({
            where: { ...where, status: 'READY', discardedAt: null },
            orderBy: { version: 'desc' },
            select: { id: true },
        }),
        context.db.documentVersion.findFirst({
            where,
            orderBy: { version: 'desc' },
            select: { id: true },
        }),
    ]);
    return documentLifecycle.parse({
        document,
        deletedAt: document.deletedAt,
        publishedVersionId: document.deletedAt ? null : (published?.id ?? null),
        latestVersionId: latest?.id ?? null,
        versions: versions.map((version) => ({
            ...version,
            fileName: version.fileName ?? document.name,
            byteSize: Number(version.byteSize),
            task: version.ingestion,
            cleanup: version.cleanup,
        })),
        total,
    });
}
/** Filter tombstones before pagination; retained content itself is never returned by this manager view. */
export async function listDeletedDocuments(
    context: AuthorizedContext,
    input: { query: string; offset: number; limit: number }
) {
    const actor = await ragActor(context, context.db, libraryWrite, true);
    const where = {
        organizationId: actor.organizationId,
        deletedAt: { not: null },
        name: { contains: input.query, mode: 'insensitive' as const },
    };
    const [items, total] = await Promise.all([
        context.db.document.findMany({
            where,
            orderBy: [{ deletedAt: 'desc' }, { id: 'asc' }],
            skip: input.offset,
            take: input.limit,
        }),
        context.db.document.count({ where }),
    ]);
    return {
        items: items.map((item) => ({ ...item, deletedAt: item.deletedAt! })),
        total,
    };
}
/** Retry an exhausted cleanup without changing its retention deadline or releasing unconfirmed storage. */
export function retryDocumentCleanup(
    context: AuthorizedContext,
    input: { id: string; versionId: string }
) {
    return mutate(context, libraryWrite, async (db, actor) => {
        const version = await db.documentVersion.findFirst({
            where: {
                id: input.versionId,
                documentId: input.id,
                organizationId: actor.organizationId,
            },
            include: { cleanup: true },
        });
        if (!version) throw new ORPCError('NOT_FOUND');
        if (version.cleanup?.status !== 'FAILED')
            throw new ORPCError('CONFLICT', {
                message: 'This cleanup is not awaiting a retry.',
            });
        await db.documentCleanup.update({
            where: { versionId: input.versionId },
            data: {
                status: 'PENDING',
                attempts: 0,
                errorCode: null,
                availableAt: new Date(
                    Math.max(Date.now(), version.cleanup.scheduledAt.getTime())
                ),
                leaseToken: null,
                leasedUntil: null,
            },
        });
        await audit(db, actor, 'document.cleanup.retried', input.id, {
            versionId: input.versionId,
        });
        return { success: true as const };
    });
}
