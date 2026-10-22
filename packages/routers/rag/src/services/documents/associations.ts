import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor, grantWhere, requireCollection } from '../access';
import { mutate, audit } from '../mutation';
import { libraryWrite, requireDocument } from './access';

const required = { ...libraryWrite, ragCollection: ['manageDocuments'] };
export async function documentCollectionCandidates(
    context: AuthorizedContext,
    input: { id: string; query: string; offset: number; limit: number }
) {
    const actor = await ragActor(context, context.db, required, true);
    await requireDocument(context.db, actor, input.id);
    const where = {
        AND: [
            grantWhere(actor, 'manageDocuments'),
            { name: { contains: input.query, mode: 'insensitive' as const } },
        ],
    };
    const [items, total] = await Promise.all([
        context.db.collection.findMany({
            where,
            skip: input.offset,
            take: input.limit,
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            select: {
                id: true,
                name: true,
                documents: {
                    where: { documentId: input.id },
                    select: { documentId: true },
                },
            },
        }),
        context.db.collection.count({ where }),
    ]);
    return {
        items: items.map(({ id, name, documents }) => ({
            id,
            name,
            attached: Boolean(documents.length),
        })),
        total,
    };
}
export function setDocumentCollection(
    context: AuthorizedContext,
    input: { id: string; collectionId: string; attached: boolean }
) {
    return mutate(context, required, async (db, actor) => {
        const document = await requireDocument(db, actor, input.id);
        await requireCollection(
            db,
            actor,
            input.collectionId,
            'manageDocuments'
        );
        if (input.attached && document.status !== 'READY')
            throw new ORPCError('CONFLICT', {
                message: 'Wait for extraction before attaching this document.',
            });
        const where = {
            ['collectionId_documentId']: {
                collectionId: input.collectionId,
                documentId: input.id,
            },
        };
        await (input.attached
            ? db.collectionDocument.upsert({
                  where,
                  create: {
                      organizationId: actor.organizationId,
                      collectionId: input.collectionId,
                      documentId: input.id,
                  },
                  update: {},
              })
            : db.collectionDocument.deleteMany({
                  where: {
                      organizationId: actor.organizationId,
                      collectionId: input.collectionId,
                      documentId: input.id,
                  },
              }));
        await audit(
            db,
            actor,
            input.attached
                ? 'document.collection.attached'
                : 'document.collection.detached',
            input.id,
            { collectionId: input.collectionId }
        );
        return { success: true as const };
    });
}
