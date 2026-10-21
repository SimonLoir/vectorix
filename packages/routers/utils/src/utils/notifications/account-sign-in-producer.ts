import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '../transactions';
import type { PrismaClient } from '@repo/db';
import {
    accountSignInSourceId,
    describeSignInDevice,
    type AccountSignInTemplateData,
} from './account-sign-in-source';
import { enqueueNotification, makeNotificationEventKey } from './enqueue';
import { notificationEventRegistry } from './registry';
import { NOTIFICATION_CHANNELS, type NotificationSource } from './types';

export type AccountSignInInput = Readonly<{
    userId: string;
    sessionId: string;
    /** Organization the new session opens in, preferred for the notice. */
    activeOrganizationId?: string | null;
    occurredAt: Date;
    ipAddress: string | null | undefined;
    userAgent: string | null | undefined;
}>;

/** True when at least one channel stays enabled once personal choices apply. */
async function memberWantsSignInNotices(
    db: PrismaClient,
    organizationId: string,
    memberId: string
) {
    const preferences = await db.vectorixNotificationPreference.findMany({
        where: {
            organizationId,
            eventType: 'ACCOUNT_SIGN_IN',
            recipient: { memberId },
        },
        select: { channel: true, enabled: true },
    });
    const overrides = new Map(
        preferences.map(({ channel, enabled }) => [channel, enabled])
    );
    const defaults = notificationEventRegistry.ACCOUNT_SIGN_IN.defaultChannels;
    return NOTIFICATION_CHANNELS.some(
        (channel) => overrides.get(channel) ?? defaults[channel]
    );
}

/**
 * Orders memberships for the single sign-in notice: the organization the
 * session opens in first, then the oldest membership (stable by ID).
 */
function signInNoticeOrder<T extends { organizationId: string }>(
    members: readonly T[],
    activeOrganizationId: string | null | undefined
) {
    return members.toSorted(
        (left, right) =>
            Number(right.organizationId === activeOrganizationId) -
            Number(left.organizationId === activeOrganizationId)
    );
}

/**
 * Records at most one ACCOUNT_SIGN_IN intent per sign-in, addressed only to
 * the signing-in user's own member in a single organization: the session's
 * active organization when one of its channels is enabled, otherwise the
 * oldest membership that still accepts the notice. Device and IP are frozen
 * in the payload because the session row may disappear before the worker
 * runs. Runs after the session commit: callers must never block sign-in.
 */
export async function enqueueAccountSignInNotifications(
    db: PrismaClient,
    input: AccountSignInInput
) {
    const members = signInNoticeOrder(
        await db.member.findMany({
            where: { userId: input.userId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, organizationId: true },
        }),
        input.activeOrganizationId
    );
    const ipAddress = input.ipAddress?.trim().slice(0, 64) ?? '';
    const templateData: AccountSignInTemplateData = {
        device: describeSignInDevice(input.userAgent),
        ipAddress: ipAddress.length > 0 ? ipAddress : null,
        signedInAt: input.occurredAt.toISOString(),
    };
    for (const member of members) {
        if (
            !(await memberWantsSignInNotices(
                db,
                member.organizationId,
                member.id
            ))
        )
            continue;
        const source: NotificationSource = {
            kind: 'ACCOUNT_SIGN_IN',
            id: accountSignInSourceId(member.id, input.sessionId),
            version: 1,
        };
        try {
            const result = await runSerializableTransaction(db, (tx) =>
                enqueueNotification(tx, {
                    organizationId: member.organizationId,
                    eventKey: makeNotificationEventKey(
                        'ACCOUNT_SIGN_IN',
                        source
                    ),
                    eventType: 'ACCOUNT_SIGN_IN',
                    occurredAt: input.occurredAt,
                    actorMemberId: null,
                    source,
                    recipients: [{ kind: 'MEMBER', memberId: member.id }],
                    templateData,
                })
            );
            return {
                enqueued: result.enqueued,
                organizationId: member.organizationId,
            };
        } catch (error) {
            // A replayed hook for the same session is already recorded.
            if (error instanceof ORPCError && error.code === 'CONFLICT')
                return {
                    enqueued: false,
                    organizationId: member.organizationId,
                };
            throw error;
        }
    }
    return { enqueued: false, organizationId: null };
}
