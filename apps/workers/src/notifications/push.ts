import type { PrismaClient } from '@repo/db';
import { decrypt } from '@routers/utils/encryption';
import {
    admitPushEndpoint,
    createPushEndpointPolicy,
    type AdmittedPushEndpoint,
    type PushEndpointPolicy,
} from '@routers/utils/push-endpoint-policy';
import type webPush from 'web-push';
import {
    classifyPushProviderFailure,
    PushDeliveryFailure,
} from './push-failure.js';
import {
    loadPushDispatch,
    type NotificationPushIdentity,
    type PushSubscriptionIdentity,
} from './push-admission.js';
import { sendNativePush } from './push-transport.js';

export type NotificationPushInput = NotificationPushIdentity;
type PushOptions = Pick<
    webPush.RequestOptions,
    'TTL' | 'urgency' | 'vapidDetails'
>;
type PushSender = (
    subscription: webPush.PushSubscription,
    payload: string,
    options: PushOptions,
    admitted: AdmittedPushEndpoint
) => Promise<webPush.SendResult>;

type PushDependencies = Readonly<{
    sendNotification?: PushSender;
    /** Internal test seam; production always uses current database admission. */
    loadDispatch?: typeof loadPushDispatch;
}>;
type StoredPushSubscription = Readonly<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
}>;

// Registration caps active devices at twenty; legacy rows cannot make one
// delivery unbounded. Each candidate is admitted again before its own request.
const MAX_DISPATCH_CANDIDATES = 20;

function vapidDetails() {
    const subject = process.env.VECTORIX_VAPID_SUBJECT?.trim();
    const publicKey = process.env.VECTORIX_VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VECTORIX_VAPID_PRIVATE_KEY?.trim();
    if (!subject || !publicKey || !privateKey)
        throw new PushDeliveryFailure('VAPID_CONFIGURATION');
    return { subject, publicKey, privateKey };
}

/** Decrypt only bounded subscription shapes; retain opaque endpoint bytes. */
function parseSubscription(value: string): StoredPushSubscription | null {
    try {
        if (value.length > 16_384) return null;
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
            parsed.keys.p256dh.length > 512 ||
            !('auth' in parsed.keys) ||
            typeof parsed.keys.auth !== 'string' ||
            parsed.keys.auth.length > 512
        )
            return null;
        return {
            endpoint: parsed.endpoint,
            keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth },
        };
    } catch {
        return null;
    }
}

async function revokeSubscription(
    db: PrismaClient,
    input: NotificationPushInput,
    subscription: PushSubscriptionIdentity,
    now: Date
) {
    await db.vectorixPushSubscription.updateMany({
        where: {
            ...subscription,
            organizationId: input.organizationId,
            recipientId: input.recipientId,
            revokedAt: null,
        },
        data: { revokedAt: now, version: { increment: 1 } },
    });
}

async function sendToPushEndpoint(
    db: PrismaClient,
    input: NotificationPushInput,
    subscription: PushSubscriptionIdentity,
    parsed: StoredPushSubscription,
    admitted: AdmittedPushEndpoint,
    payload: string,
    sender: PushSender,
    details: ReturnType<typeof vapidDetails>
): Promise<'SENT' | 'REVOKED' | PushDeliveryFailure> {
    try {
        await sender(
            parsed,
            payload,
            {
                TTL: 60 * 60,
                urgency: 'normal',
                vapidDetails: details,
            },
            admitted
        );
    } catch (error) {
        const failure = classifyPushProviderFailure(error);
        if ([404, 410].includes(failure.providerHttpStatus ?? 0)) {
            await revokeSubscription(db, input, subscription, new Date());
            return 'REVOKED';
        }
        return failure;
    }
    await db.vectorixPushSubscription.updateMany({
        where: {
            ...subscription,
            organizationId: input.organizationId,
            recipientId: input.recipientId,
            revokedAt: null,
        },
        data: { lastUsedAt: new Date() },
    });
    // A later revocation cannot recall an already accepted provider request.
    return 'SENT';
}

/** Expiry cleanup is versioned and independent of operator destination policy. */
export function cleanupExpiredPushSubscriptions(
    db: PrismaClient,
    now: Date
): Promise<{ count: number }> {
    return db.vectorixPushSubscription.updateMany({
        where: { revokedAt: null, expirationTime: { lte: now } },
        data: { revokedAt: now, version: { increment: 1 } },
    });
}

/**
 * Dispatch only current, scoped devices under the live durable delivery lease.
 * Operator policy and authorization are checked for every device, including
 * historical rows. Policy rejection never mass-revokes stored subscriptions.
 * Network I/O stays outside the bounded admission transaction; retries retain
 * the existing at-least-once delivery semantics.
 */
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
        select: { id: true, version: true },
        orderBy: { id: 'asc' },
        take: MAX_DISPATCH_CANDIDATES,
    });
    if (!subscriptions.length)
        return { sent: false, reason: 'NO_ACTIVE_PUSH_SUBSCRIPTION' } as const;

    const sender = dependencies.sendNotification ?? sendNativePush;
    let sent = 0;
    let retryable = 0;
    let failure: PushDeliveryFailure | null = null;
    let details: ReturnType<typeof vapidDetails> | null = null;
    for (const candidate of subscriptions) {
        if (process.env.VECTORIX_WEB_PUSH_ENABLED !== 'true') break;
        const current = await (dependencies.loadDispatch ?? loadPushDispatch)(
            db,
            input,
            candidate,
            new Date()
        );
        if (!current) continue;
        let policy: PushEndpointPolicy;
        try {
            policy = createPushEndpointPolicy(
                process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS
            );
        } catch (error) {
            // Do not retry already accepted devices merely because policy changed
            // before another device. With no acceptance, use bounded outbox retry.
            if (sent > 0) break;
            throw error;
        }
        const parsed = parseSubscription(
            current.subscription.subscriptionEncrypted
        );
        if (!parsed) {
            await revokeSubscription(db, input, candidate, new Date());
            continue;
        }
        const admitted = admitPushEndpoint(parsed.endpoint, policy);
        if (!admitted) continue;
        // The read transaction can outlast a deadline that was future at its
        // start. Check its saved lease/device deadlines against the live clock.
        const dispatchTime = Date.now();
        if (
            current.leasedUntil.getTime() <= dispatchTime ||
            (current.subscription.expirationTime !== null &&
                current.subscription.expirationTime.getTime() <= dispatchTime)
        )
            continue;
        const result = await sendToPushEndpoint(
            db,
            input,
            candidate,
            parsed,
            admitted,
            current.payload,
            sender,
            (details ??= vapidDetails())
        );
        if (result === 'SENT') sent += 1;
        else if (result !== 'REVOKED') {
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
