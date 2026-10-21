import { ragV1 } from '../v1-implementer';
import { ragActor, documentWhere } from '../services/access';
export const listDocuments = ragV1.documents.list.handler(
    async ({ context, input }) => {
        const actor = await ragActor(context, context.db, {
            ragLibrary: ['read'],
        });
        const where = {
            AND: [
                documentWhere(actor),
                {
                    name: {
                        contains: input.query,
                        mode: 'insensitive' as const,
                    },
                },
            ],
        };
        const [items, total] = await Promise.all([
            context.db.document.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: input.offset,
                take: input.limit,
            }),
            context.db.document.count({ where }),
        ]);
        return { items, total };
    }
);
