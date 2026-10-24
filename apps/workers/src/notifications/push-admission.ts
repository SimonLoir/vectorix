import type { PrismaClient } from '@repo/db';
import {
    accountSignInSourceExists,
    notificationActionPath,
    notificationEventRegistry,
} from '@routers/utils/notifications';

export type NotificationPushIdentity = Readonly<{
    organizationId: string;
    recipientId: string;
    notificationId: string;
    deliveryId: string;
    leaseToken: string;
}>;

export type PushSubscriptionIdentity = Readonly<{
    id: string;
    version: number;
}>;

/**
 * Read a consistent, current admission immediately before one device dispatch.
 * No network call runs inside this transaction. A previous device's admission
 * never authorizes the next device; revoked leases and preferences fail closed.
 * Changes after this snapshot cannot recall a request already in flight.
 */
export function loadPushDispatch(
    db: PrismaClient,
    input: NotificationPushIdentity,
    candidate: PushSubscriptionIdentity,
    now: Date
) {
    return db.$transaction(
        async (tx) => {
            const delivery = await tx.vectorixNotificationDelivery.findFirst({
                where: {
                    id: input.deliveryId,
                    organizationId: input.organizationId,
                    notificationId: input.notificationId,
                    channel: 'PUSH',
                    status: 'PROCESSING',
                    leaseToken: input.leaseToken,
                    leasedUntil: { gt: now },
                    organization: { isActive: true },
                    notification: {
                        recipientId: input.recipientId,
                        recipient: {
                            kind: 'MEMBER',
                            member: {
                                is: { organizationId: input.organizationId },
                            },
                        },
                    },
                },
                select: {
                    leasedUntil: true,
                    notification: {
                        select: {
                            id: true,
                            eventType: true,
                            sourceKind: true,
                            sourceId: true,
                            sourceVersion: true,
                            title: true,
                            body: true,
                            recipient: { select: { memberId: true } },
                        },
                    },
                },
            });
            const notification = delivery?.notification;
            const memberId = notification?.recipient.memberId;
            const leasedUntil = delivery?.leasedUntil;
            if (
                !notification ||
                !memberId ||
                !leasedUntil ||
                notification.eventType !== 'ACCOUNT_SIGN_IN' ||
                notification.sourceKind !==
                    notificationEventRegistry.ACCOUNT_SIGN_IN.sourceKind ||
                notification.sourceVersion !== 1 ||
                !(await accountSignInSourceExists(
                    tx,
                    input.organizationId,
                    notification.sourceId,
                    memberId
                ))
            )
                return null;

            const preference =
                await tx.vectorixNotificationPreference.findUnique({
                    where: {
                        ['organizationId_recipientId_eventType_channel']: {
                            organizationId: input.organizationId,
                            recipientId: input.recipientId,
                            eventType: 'ACCOUNT_SIGN_IN',
                            channel: 'PUSH',
                        },
                    },
                    select: { enabled: true },
                });
            if (!(
                preference?.enabled ??
                notificationEventRegistry.ACCOUNT_SIGN_IN.defaultChannels.PUSH
            ))
                return null;

            const subscription = await tx.vectorixPushSubscription.findFirst({
                where: {
                    id: candidate.id,
                    version: candidate.version,
                    organizationId: input.organizationId,
                    recipientId: input.recipientId,
                    application: 'VECTORIX_DASHBOARD',
                    revokedAt: null,
                    OR: [
                        { expirationTime: null },
                        { expirationTime: { gt: now } },
                    ],
                },
                select: {
                    id: true,
                    version: true,
                    organizationId: true,
                    endpointHash: true,
                    subscriptionEncrypted: true,
                    expirationTime: true,
                },
            });
            if (!subscription) return null;
            return {
                leasedUntil,
                subscription,
                payload: JSON.stringify({
                    version: 1,
                    notificationId: notification.id,
                    title: notification.title,
                    body: notification.body,
                    path: notificationActionPath({
                        kind: 'ACCOUNT',
                        version: 1,
                    }),
                }),
            };
        },
        { isolationLevel: 'RepeatableRead', maxWait: 1000, timeout: 15_000 }
    );
}
