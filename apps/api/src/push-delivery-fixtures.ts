import assert from 'node:assert/strict';
import { createECDH, randomUUID } from 'node:crypto';
import { prisma } from '@repo/db';
import {
    accountSignInSourceId,
    enqueueAccountSignInNotifications,
} from '@routers/utils/notifications';
import {
    createPushNotificationAccount,
    pushSubscriptionInput,
    requirePushTestDatabase,
    type PushFixtureCleanup,
} from './push-subscription-fixtures';
import { object, stringField } from './user-locale-tests/http';

const environmentKeys = [
    'VECTORIX_WEB_PUSH_ENABLED',
    'VECTORIX_WEB_PUSH_ALLOWED_ORIGINS',
    'VECTORIX_VAPID_SUBJECT',
    'VECTORIX_VAPID_PUBLIC_KEY',
    'VECTORIX_VAPID_PRIVATE_KEY',
] as const;

/** Local VAPID only; callers always inject the sender and must never dispatch to a provider. */
export function configurePushDeliveryEnvironment() {
    requirePushTestDatabase();
    const saved = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    const keys = createECDH('prime256v1');
    keys.generateKeys();
    process.env.VECTORIX_WEB_PUSH_ENABLED = 'true';
    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
    process.env.VECTORIX_VAPID_SUBJECT = 'mailto:push-tests@example.test';
    process.env.VECTORIX_VAPID_PUBLIC_KEY = keys
        .getPublicKey()
        .toString('base64url');
    process.env.VECTORIX_VAPID_PRIVATE_KEY = keys
        .getPrivateKey()
        .toString('base64url');
    return () => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
}

/** An acknowledged provider response in injected tests is never a real delivery claim. */
export const acceptedPushResponse = { statusCode: 201, body: '', headers: {} };

/**
 * Real native account/preferences/subscription registration plus the production
 * notification producer. Only the owned durable delivery's PROCESSING lease is
 * an explicit ORM fixture; no worker or external transport is started.
 */
export async function createPushDeliveryFixture(
    cleanup: PushFixtureCleanup,
    label: string,
    ordinaryMember = false
) {
    requirePushTestDatabase();
    const owner = await createPushNotificationAccount(cleanup, label);
    let recipient = owner;
    if (ordinaryMember) {
        const peer = await createPushNotificationAccount(
            cleanup,
            `${label}-member`
        );
        const member = await prisma.member.create({
            data: {
                id: randomUUID(),
                userId: peer.userId,
                organizationId: owner.organizationId,
                role: 'member',
                createdAt: new Date(),
            },
        });
        await peer.native('organization/set-active', {
            organizationId: owner.organizationId,
        });
        recipient = {
            ...peer,
            organizationId: owner.organizationId,
            memberId: member.id,
        };
    }
    const preferences =
        await recipient.client.admin.notifications.preferences.get({});
    await recipient.client.admin.notifications.preferences.update({
        expectedOrganizationId: recipient.organizationId,
        changes: preferences.preferences.map((preference) => ({
            eventType: preference.eventType,
            channel: preference.channel,
            enabled: preference.channel === 'PUSH',
            expectedVersion: preference.version,
        })),
    });
    const session = object(await recipient.native('get-session'));
    const sessionId = stringField(object(session.session).id);
    const sourceId = accountSignInSourceId(recipient.memberId, sessionId);
    const produced = await enqueueAccountSignInNotifications(prisma, {
        userId: recipient.userId,
        sessionId,
        activeOrganizationId: recipient.organizationId,
        occurredAt: new Date(),
        ipAddress: '192.0.2.1',
        userAgent: 'Firefox/128 Linux',
    });
    assert.equal(produced.enqueued, true);
    assert.equal(produced.organizationId, recipient.organizationId);
    const notification = await prisma.vectorixNotification.findFirstOrThrow({
        where: { organizationId: recipient.organizationId, sourceId },
        select: { id: true, recipientId: true, title: true, body: true },
    });
    const delivery = await prisma.vectorixNotificationDelivery.findFirstOrThrow(
        {
            where: {
                organizationId: recipient.organizationId,
                notificationId: notification.id,
                channel: 'PUSH',
            },
            select: { id: true, status: true },
        }
    );
    assert.equal(delivery.status, 'PENDING');
    const leaseToken = randomUUID();
    const claim = await prisma.vectorixNotificationDelivery.updateMany({
        where: {
            id: delivery.id,
            organizationId: recipient.organizationId,
            status: 'PENDING',
        },
        data: {
            status: 'PROCESSING',
            leaseToken,
            leasedUntil: new Date(Date.now() + 60_000),
            attempts: { increment: 1 },
        },
    });
    assert.equal(claim.count, 1);
    const devices: {
        id: string;
        version: number;
        registration: ReturnType<typeof pushSubscriptionInput>;
    }[] = [];
    for (let index = 0; index < 2; index++) {
        const endpoint = `https://fcm.googleapis.com/wp/${randomUUID()}/${index}/a/../b%2f%2F?opaque=A%2Bb&same=1&same=2`;
        const registration = pushSubscriptionInput(
            recipient.organizationId,
            endpoint
        );
        const result =
            await recipient.client.admin.notifications.pushSubscriptions.register(
                registration
            );
        devices.push({ ...result, registration });
    }
    const ordered = await prisma.vectorixPushSubscription.findMany({
        where: {
            organizationId: recipient.organizationId,
            recipientId: notification.recipientId,
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 3,
    });
    assert.equal(ordered.length, 2);
    const orderedDevices = ordered.map((row) => {
        const device = devices.find((item) => item.id === row.id);
        assert.ok(
            device,
            'The candidate must be one of the two native registrations.'
        );
        return device;
    });
    return {
        owner,
        recipient,
        notification,
        devices: orderedDevices,
        input: {
            organizationId: recipient.organizationId,
            recipientId: notification.recipientId,
            notificationId: notification.id,
            deliveryId: delivery.id,
            leaseToken,
        },
    };
}

export type PushDeliveryFixture = Awaited<
    ReturnType<typeof createPushDeliveryFixture>
>;

/** Change the saved preference through the actual native-session RPC handler. */
export async function disablePushPreference(fixture: PushDeliveryFixture) {
    const preferences =
        await fixture.recipient.client.admin.notifications.preferences.get({});
    const push = preferences.preferences.find(
        (preference) => preference.channel === 'PUSH'
    );
    assert.ok(push);
    await fixture.recipient.client.admin.notifications.preferences.update({
        expectedOrganizationId: fixture.input.organizationId,
        changes: [
            {
                eventType: 'ACCOUNT_SIGN_IN',
                channel: 'PUSH',
                enabled: false,
                expectedVersion: push.version,
            },
        ],
    });
}
