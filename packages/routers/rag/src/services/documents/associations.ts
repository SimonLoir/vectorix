import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor, grantWhere, requireCollection } from '../access';
import { mutate, audit } from '../mutation';
import { libraryWrite, requireDocument } from './access';
import { recordDocumentChange } from '../indexing/changes';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from '../indexing/limits';
import { indexError } from '../indexing/errors';

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
        const current = await db.collectionDocument.findUnique({ where });
        if (Boolean(current) === input.attached)
            return { success: true as const };
        if (
            input.attached &&
            (await db.indexGeneration.count({
                where: {
                    organizationId: actor.organizationId,
                    collectionId: input.collectionId,
                    status: { not: 'CLEANED' },
                },
            })) &&
            (await db.collectionDocument.count({
                where: {
                    organizationId: actor.organizationId,
                    collectionId: input.collectionId,
                },
            })) >= MAX_INDEXED_DOCUMENTS_PER_COLLECTION
        )
            throw indexError('QUOTA_EXCEEDED');
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
        await recordDocumentChange(db, {
            organizationId: actor.organizationId,
            collectionId: input.collectionId,
            documentId: input.id,
            kind: input.attached ? 'UPSERT' : 'REMOVE',
            requestedBy: actor.userId,
        });
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
