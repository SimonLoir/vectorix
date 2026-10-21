import { ragV1 } from './v1-implementer';
import { ragActor } from './services/access';
export const listAudit = ragV1.audit.handler(async ({ context, input }) => {
    const actor = await ragActor(
        context,
        context.db,
        { ragAudit: ['read'] },
        true
    );
    const where = {
        organizationId: actor.organizationId,
        action: { contains: input.query, mode: 'insensitive' as const },
    };
    const [items, total] = await Promise.all([
        context.db.ragAuditLog.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: input.offset,
            take: input.limit,
        }),
        context.db.ragAuditLog.count({ where }),
    ]);
    return {
        items: items.map((item) => ({
            ...item,
            details: item.details as Record<
                string,
                string | number | boolean
            > | null,
        })),
        total,
    };
});
