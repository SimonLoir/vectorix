import { ORPCError } from '@orpc/server';
import { ragV1 } from '../v1-implementer';
import { ragActor, documentWhere } from '../services/access';
export const getDocument = ragV1.documents.get.handler(
    async ({ context, input }) => {
        const actor = await ragActor(context, context.db, {
            ragLibrary: ['read'],
        });
        const document = await context.db.document.findFirst({
            where: { AND: [documentWhere(actor), { id: input.id }] },
        });
        if (!document) throw new ORPCError('NOT_FOUND');
        return document;
    }
);
