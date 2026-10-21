import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { accountSignInSourceExists } from '@routers/utils/notifications';
export type NotificationAccessRow = Readonly<{
    id: string;
    eventType: string;
    sourceKind: string;
    sourceId: string;
    sourceVersion: number;
}>;
/** Recheck current membership and ownership before revealing account notifications. */
export async function visibleNotificationIds(
    context: AuthorizedContext,
    memberId: string,
    rows: readonly NotificationAccessRow[]
) {
    const member =
        context.user &&
        (await context.db.member.findFirst({
            where: {
                id: memberId,
                organizationId: context.organizationId,
                userId: context.user.id,
            },
        }));
    if (!member) throw new ORPCError('UNAUTHORIZED');
    const visible = await Promise.all(
        rows.map(async (row) =>
            row.eventType === 'ACCOUNT_SIGN_IN' &&
            row.sourceKind === 'ACCOUNT_SIGN_IN' &&
            (await accountSignInSourceExists(
                context.db,
                context.organizationId,
                row.sourceId,
                memberId
            ))
                ? row.id
                : null
        )
    );
    return new Set(visible.filter((id): id is string => id !== null));
}
