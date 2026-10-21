import { ORPCError } from '@orpc/server';
import type { Prisma, PrismaClient } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';

type NotificationIdentityDb = Pick<
    PrismaClient | Prisma.TransactionClient,
    'member' | 'vectorixNotificationRecipient'
>;

export type NotificationSession = Readonly<{
    organizationId: string;
    userId: string;
    memberId: string;
    recipientId: string | null;
}>;

function requireRealSession(context: AuthorizedContext) {
    if (!context.user || !context.session || context.key) {
        throw new ORPCError('FORBIDDEN', {
            message: 'Notifications require an authenticated member session.',
        });
    }
    return context.user.id;
}

export function assertExpectedOrganization(
    actualOrganizationId: string,
    expectedOrganizationId: string
) {
    if (actualOrganizationId !== expectedOrganizationId) {
        throw new ORPCError('CONFLICT', {
            message: 'The active organization has changed. Reload and retry.',
        });
    }
}

export async function getNotificationSession(
    context: AuthorizedContext,
    db: NotificationIdentityDb = context.db
): Promise<NotificationSession> {
    const userId = requireRealSession(context);
    const member = await db.member.findFirst({
        where: {
            organizationId: context.organizationId,
            userId,
        },
        select: { id: true },
    });
    if (!member) throw new ORPCError('UNAUTHORIZED');

    const recipient = await db.vectorixNotificationRecipient.findUnique({
        where: {
            ['organizationId_memberId']: {
                organizationId: context.organizationId,
                memberId: member.id,
            },
        },
        select: { id: true },
    });
    return {
        organizationId: context.organizationId,
        userId,
        memberId: member.id,
        recipientId: recipient?.id ?? null,
    };
}

export function ensureMemberRecipient(
    db: NotificationIdentityDb,
    session: NotificationSession
) {
    return db.vectorixNotificationRecipient.upsert({
        where: {
            ['organizationId_memberId']: {
                organizationId: session.organizationId,
                memberId: session.memberId,
            },
        },
        create: {
            organizationId: session.organizationId,
            kind: 'MEMBER',
            memberOrganizationId: session.organizationId,
            memberId: session.memberId,
        },
        update: {},
        select: { id: true, lastSequence: true },
    });
}
