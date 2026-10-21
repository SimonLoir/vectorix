import type { PrismaClient } from '@repo/db';
import { decrypt } from '@routers/utils/encryption';
import {
    notificationActionPath,
    type NotificationAction,
} from '@routers/utils/notifications';
import webPush from 'web-push';
import {
    classifyPushProviderFailure,
    PushDeliveryFailure,
} from './push-failure.js';

type PushSender = (
    subscription: webPush.PushSubscription,
    payload: string,
    options: webPush.RequestOptions
) => Promise<webPush.SendResult>;

export type NotificationPushInput = Readonly<{
    organizationId: string;
    recipientId: string;
    notificationId: string;
    title: string;
    body: string;
    action: NotificationAction;
}>;

type PushDependencies = Readonly<{
    sendNotification?: PushSender;
}>;

type StoredPushSubscription = Readonly<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
}>;

function vapidDetails() {
    const subject = process.env.VECTORIX_VAPID_SUBJECT?.trim();
    const publicKey = process.env.VECTORIX_VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VECTORIX_VAPID_PRIVATE_KEY?.trim();
    if (!subject || !publicKey || !privateKey)
        throw new PushDeliveryFailure('VAPID_CONFIGURATION');
    return { subject, publicKey, privateKey };
}

function parseSubscription(value: string): StoredPushSubscription | null {
    try {
        const parsed = JSON.parse(decrypt(value)) as unknown;
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('endpoint' in parsed) ||
            typeof parsed.endpoint !== 'string' ||
            !('keys' in parsed) ||
            typeof parsed.keys !== 'object' ||
            parsed.keys === null ||
            !('p256dh' in parsed.keys) ||
            typeof parsed.keys.p256dh !== 'string' ||
            !('auth' in parsed.keys) ||
            typeof parsed.keys.auth !== 'string'
        )
            return null;
        const endpoint = new URL(parsed.endpoint);
        if (endpoint.protocol !== 'https:') return null;
        return {
            endpoint: endpoint.toString(),
            keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth },
        };
    } catch {
        return null;
    }
}

async function revokeSubscription(
    db: PrismaClient,
    subscription: { id: string; version: number },
    now: Date
) {
    await db.vectorixPushSubscription.updateMany({
        where: {
            id: subscription.id,
            version: subscription.version,
            revokedAt: null,
        },
        data: { revokedAt: now, version: { increment: 1 } },
    });
}

async function sendToPushEndpoint(
    db: PrismaClient,
    subscription: { id: string; version: number },
    parsed: StoredPushSubscription,
    payload: string,
    sender: PushSender,
    details: ReturnType<typeof vapidDetails>,
    now: Date
): Promise<'SENT' | 'REVOKED' | PushDeliveryFailure> {
    try {
        await sender(parsed, payload, {
            TTL: 60 * 60,
            urgency: 'normal',
            vapidDetails: details,
        });
    } catch (error) {
        const failure = classifyPushProviderFailure(error);
        if ([404, 410].includes(failure.providerHttpStatus ?? 0)) {
            await revokeSubscription(db, subscription, now);
            return 'REVOKED';
        }
        return failure;
    }
    await db.vectorixPushSubscription.updateMany({
        where: {
            id: subscription.id,
            version: subscription.version,
            revokedAt: null,
        },
        data: { lastUsedAt: now },
    });
    return 'SENT';
}

export function cleanupExpiredPushSubscriptions(
    db: PrismaClient,
    now: Date
): Promise<{ count: number }> {
    return db.vectorixPushSubscription.updateMany({
        where: { revokedAt: null, expirationTime: { lte: now } },
        data: { revokedAt: now, version: { increment: 1 } },
    });
}

export async function sendNotificationPush(
    db: PrismaClient,
    input: NotificationPushInput,
    now: Date,
    dependencies: PushDependencies = {}
) {
    if (process.env.VECTORIX_WEB_PUSH_ENABLED !== 'true')
        return { sent: false, reason: 'PUSH_DISABLED' } as const;

    const subscriptions = await db.vectorixPushSubscription.findMany({
        where: {
            organizationId: input.organizationId,
            recipientId: input.recipientId,
            application: 'VECTORIX_DASHBOARD',
            revokedAt: null,
            OR: [{ expirationTime: null }, { expirationTime: { gt: now } }],
        },
        select: {
            id: true,
            version: true,
            subscriptionEncrypted: true,
        },
        orderBy: { id: 'asc' },
    });
    if (!subscriptions.length)
        return { sent: false, reason: 'NO_ACTIVE_PUSH_SUBSCRIPTION' } as const;

    const sender = dependencies.sendNotification ?? webPush.sendNotification;
    const payload = JSON.stringify({
        version: 1,
        notificationId: input.notificationId,
        title: input.title,
        body: input.body,
        path: notificationActionPath(input.action),
    });
    let sent = 0;
    let retryable = 0;
    let failure: PushDeliveryFailure | null = null;
    let details: ReturnType<typeof vapidDetails> | null = null;
    for (const subscription of subscriptions) {
        const parsed = parseSubscription(subscription.subscriptionEncrypted);
        if (!parsed) {
            await revokeSubscription(db, subscription, now);
            continue;
        }
        const result = await sendToPushEndpoint(
            db,
            subscription,
            parsed,
            payload,
            sender,
            (details ??= vapidDetails()),
            now
        );
        if (result === 'SENT') {
            sent += 1;
        } else if (result !== 'REVOKED') {
            retryable += 1;
            if (
                !failure ||
                (failure.providerHttpStatus === null &&
                    result.providerHttpStatus !== null)
            )
                failure = result;
        }
    }
    if (sent > 0) return { sent: true } as const;
    if (retryable > 0)
        throw failure ?? new PushDeliveryFailure('PROVIDER_UNKNOWN_ERROR');
    return { sent: false, reason: 'NO_VALID_PUSH_SUBSCRIPTION' } as const;
}
