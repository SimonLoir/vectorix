import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import {
    notificationEventRegistry,
    accountSignInSourceExists,
} from '@routers/utils/notifications';
import { sendSystemMail, escapeHtml } from '@repo/emails';
import { sendNotificationPush } from './push';
/** Lease durable deliveries, recheck ownership/preferences, and retry failures with bounded backoff. */
export async function processNotifications(db: PrismaClient) {
    const now = new Date();
    const due = await db.vectorixNotificationDelivery.findMany({
        where: {
            channel: { in: ['EMAIL', 'PUSH'] },
            availableAt: { lte: now },
            OR: [
                { status: 'PENDING' },
                { status: 'PROCESSING', leasedUntil: { lt: now } },
            ],
        },
        orderBy: { availableAt: 'asc' },
        take: 50,
        select: { id: true },
    });
    for (const row of due) {
        const token = randomUUID();
        const claim = await db.vectorixNotificationDelivery.updateMany({
            where: {
                id: row.id,
                OR: [
                    { status: 'PENDING' },
                    { status: 'PROCESSING', leasedUntil: { lt: now } },
                ],
            },
            data: {
                status: 'PROCESSING',
                leaseToken: token,
                leasedUntil: new Date(Date.now() + 600_000),
                attempts: { increment: 1 },
            },
        });
        if (!claim.count) continue;
        const delivery =
            await db.vectorixNotificationDelivery.findUniqueOrThrow({
                where: { id: row.id },
                include: {
                    notification: {
                        include: {
                            recipient: {
                                include: {
                                    member: { include: { user: true } },
                                },
                            },
                        },
                    },
                },
            });
        const notification = delivery.notification;
        const member = notification.recipient.member;
        try {
            const preference =
                await db.vectorixNotificationPreference.findUnique({
                    where: {
                        ['organizationId_recipientId_eventType_channel']: {
                            organizationId: notification.organizationId,
                            recipientId: notification.recipientId,
                            eventType: notification.eventType,
                            channel: delivery.channel,
                        },
                    },
                });
            const valid =
                notification.eventType === 'ACCOUNT_SIGN_IN' &&
                member &&
                (await accountSignInSourceExists(
                    db,
                    notification.organizationId,
                    notification.sourceId,
                    member.id
                ));
            const enabled =
                preference?.enabled ??
                notificationEventRegistry.ACCOUNT_SIGN_IN.defaultChannels[
                    delivery.channel
                ];
            if (!valid || !enabled) {
                await db.vectorixNotificationDelivery.updateMany({
                    where: { id: row.id, leaseToken: token },
                    data: {
                        status: 'SKIPPED',
                        skippedAt: new Date(),
                        leaseToken: null,
                        leasedUntil: null,
                    },
                });
                continue;
            }
            if (delivery.channel === 'EMAIL') {
                const url = new URL(
                    '/dashboard/account',
                    process.env.VECTORIX_WEB_URL ?? 'http://localhost:3000'
                ).toString();
                await sendSystemMail(
                    member.user.email,
                    notification.title,
                    `<h1>${escapeHtml(notification.title)}</h1><p>${escapeHtml(notification.body)}</p><p><a href="${escapeHtml(url)}">Ouvrir mon compte</a></p>`
                );
            } else {
                const result = await sendNotificationPush(
                    db,
                    {
                        organizationId: notification.organizationId,
                        recipientId: notification.recipientId,
                        notificationId: notification.id,
                        title: notification.title,
                        body: notification.body,
                        action: { kind: 'ACCOUNT', version: 1 },
                    },
                    new Date()
                );
                if (!result.sent) {
                    await db.vectorixNotificationDelivery.updateMany({
                        where: { id: row.id, leaseToken: token },
                        data: {
                            status: 'SKIPPED',
                            skippedAt: new Date(),
                            leaseToken: null,
                            leasedUntil: null,
                        },
                    });
                    continue;
                }
            }
            await db.vectorixNotificationDelivery.updateMany({
                where: { id: row.id, leaseToken: token },
                data: {
                    status: 'SENT',
                    sentAt: new Date(),
                    leaseToken: null,
                    leasedUntil: null,
                    lastError: null,
                },
            });
        } catch {
            const terminal = delivery.attempts >= 5;
            await db.vectorixNotificationDelivery.updateMany({
                where: { id: row.id, leaseToken: token },
                data: {
                    status: terminal ? 'FAILED' : 'PENDING',
                    failedAt: terminal ? new Date() : null,
                    availableAt: new Date(
                        Date.now() +
                            Math.min(3_600_000, 10_000 * 2 ** delivery.attempts)
                    ),
                    leaseToken: null,
                    leasedUntil: null,
                    lastError: 'Notification provider delivery failed',
                },
            });
        }
    }
    return { scanned: due.length };
}
