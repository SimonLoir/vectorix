import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor, documentWhere, type RagActor } from '../access';

export const libraryWrite = { ragLibrary: ['read', 'readAll', 'write'] };
export async function requireDocument(
    db: Prisma.TransactionClient,
    actor: RagActor,
    id: string
) {
    const document = await db.document.findFirst({
        where: { AND: [documentWhere(actor), { id }] },
    });
    if (!document) throw new ORPCError('NOT_FOUND');
    return document;
}
/** Re-run this before and after object access: a URL or previously loaded page never grants content access. */
export async function contentDocument(context: AuthorizedContext, id: string) {
    const actor = await ragActor(context, context.db, { ragLibrary: ['read'] });
    const document = await requireDocument(context.db, actor, id);
    const published = await context.db.documentVersion.findFirst({
        where: {
            organizationId: actor.organizationId,
            documentId: id,
            discardedAt: null,
            contentState: 'AVAILABLE',
            status: 'READY',
        },
        orderBy: { version: 'desc' },
        include: { extraction: true, ingestion: true },
    });
    const version =
        published ??
        (await context.db.documentVersion.findFirst({
            where: {
                organizationId: actor.organizationId,
                documentId: id,
                discardedAt: null,
                contentState: 'AVAILABLE',
            },
            orderBy: { version: 'desc' },
            include: { extraction: true, ingestion: true },
        }));
    if (!version) throw new ORPCError('NOT_FOUND');
    return { actor, document, version };
}

/** Revalidate the exact source after private I/O, even if a replacement changed the current publication meanwhile. */
export async function requireReadableVersion(
    context: AuthorizedContext,
    documentId: string,
    versionId: string
) {
    const { actor } = await contentDocument(context, documentId);
    const version = await context.db.documentVersion.findFirst({
        where: {
            id: versionId,
            documentId,
            organizationId: actor.organizationId,
            contentState: 'AVAILABLE',
            discardedAt: null,
        },
        include: { extraction: true },
    });
    if (!version) throw new ORPCError('NOT_FOUND');
    return version;
}
