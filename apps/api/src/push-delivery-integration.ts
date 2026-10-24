import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@repo/db';
import { encrypt, pushSubscriptionContext } from '@routers/utils/encryption';
import { PushEndpointPolicyConfigurationError } from '@routers/utils/push-endpoint-policy';
import { sendNotificationPush } from '../../workers/src/notifications/push';
import {
    assertPushRegistrationUnchanged,
    pushRegistrationSnapshot,
    requirePushTestDatabase,
    type PushFixtureCleanup,
} from './push-subscription-fixtures';
import {
    acceptedPushResponse,
    configurePushDeliveryEnvironment,
    createPushDeliveryFixture,
} from './push-delivery-fixtures';
import { object } from './user-locale-tests/http';
import { pushProviderIntegrationTests } from './push-provider-integration';
import { pushReadmissionIntegrationTests } from './push-readmission-integration';

/** Real catalog readmission with an injected acknowledged transport; never a real push-provider claim. */
export async function pushDeliveryIntegrationTests(
    t: TestContext,
    cleanup: PushFixtureCleanup
) {
    requirePushTestDatabase();
    const restore = configurePushDeliveryEnvironment();
    try {
        await t.test(
            'two native devices dispatch the current payload and exact opaque targets under one real durable lease',
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    'functional'
                );
                let calls = 0;
                const result = await sendNotificationPush(
                    prisma,
                    fixture.input,
                    new Date(),
                    {
                        sendNotification: (
                            subscription,
                            payload,
                            options,
                            admitted
                        ) => {
                            const expected = fixture.devices[calls++]!;
                            assert.ok(
                                subscription.endpoint ===
                                    expected.registration.endpoint &&
                                    admitted.endpoint === subscription.endpoint,
                                'Native dispatch must preserve the exact registered endpoint.'
                            );
                            assert.equal(
                                admitted.hostname,
                                'fcm.googleapis.com'
                            );
                            assert.ok(
                                admitted.requestPath ===
                                    expected.registration.endpoint.slice(
                                        'https://fcm.googleapis.com'.length
                                    ),
                                'Native dispatch must retain opaque dot segments and query encoding.'
                            );
                            const data = object(JSON.parse(payload));
                            assert.ok(
                                data.version === 1 &&
                                    data.notificationId ===
                                        fixture.notification.id &&
                                    data.title === fixture.notification.title &&
                                    data.body === fixture.notification.body &&
                                    data.path === '/dashboard/account',
                                'Payload must come from the current scoped notification.'
                            );
                            assert.equal(options.TTL, 3600);
                            assert.equal(options.urgency, 'normal');
                            assert.ok(
                                options.vapidDetails &&
                                    Buffer.from(
                                        options.vapidDetails.publicKey,
                                        'base64url'
                                    ).length === 65 &&
                                    Buffer.from(
                                        options.vapidDetails.privateKey,
                                        'base64url'
                                    ).length === 32,
                                'The injected sender must receive locally generated valid VAPID key bytes.'
                            );
                            return Promise.resolve(acceptedPushResponse);
                        },
                    }
                );
                assert.equal(result.sent, true);
                assert.equal(calls, 2);
                const devices = await prisma.vectorixPushSubscription.findMany({
                    where: {
                        id: { in: fixture.devices.map((device) => device.id) },
                    },
                });
                assert.ok(
                    devices.every(
                        (device) =>
                            device.lastUsedAt !== null &&
                            device.revokedAt === null
                    )
                );
            }
        );

        await t.test(
            'a legacy encrypted disallowed endpoint is skipped without revocation or ciphertext mutation',
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    'legacy'
                );
                const first = fixture.devices[0]!;
                const endpoint = `https://127.0.0.1/legacy-${randomUUID()}`;
                const endpointHash = createHash('sha256')
                    .update(endpoint)
                    .digest('hex');
                const row =
                    await prisma.vectorixPushSubscription.findUniqueOrThrow({
                        where: { id: first.id },
                        select: { organizationId: true },
                    });
                await prisma.vectorixPushSubscription.update({
                    where: { id: first.id },
                    data: {
                        endpointHash,
                        subscriptionEncrypted: await encrypt(
                            JSON.stringify({ ...first.registration, endpoint }),
                            pushSubscriptionContext(
                                row.organizationId,
                                endpointHash
                            )
                        ),
                    },
                });
                const before =
                    await prisma.vectorixPushSubscription.findUniqueOrThrow({
                        where: { id: first.id },
                    });
                let calls = 0;
                const result = await sendNotificationPush(
                    prisma,
                    fixture.input,
                    new Date(),
                    {
                        sendNotification: (subscription) => {
                            calls++;
                            assert.ok(
                                subscription.endpoint ===
                                    fixture.devices[1]!.registration.endpoint,
                                'A blocked endpoint must never reach the sender.'
                            );
                            return Promise.resolve(acceptedPushResponse);
                        },
                    }
                );
                assert.equal(result.sent, true);
                assert.equal(calls, 1);
                assert.ok(
                    isDeepStrictEqual(
                        await prisma.vectorixPushSubscription.findUniqueOrThrow(
                            { where: { id: first.id } }
                        ),
                        before
                    ),
                    'Operator policy must not revoke or rewrite a legacy subscription.'
                );
            }
        );

        await pushReadmissionIntegrationTests(t, cleanup);

        await t.test(
            'foreign catalog identifiers and an invalid lease cause zero sends and zero subscription writes',
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    'scoped'
                );
                const foreign = await createPushDeliveryFixture(
                    cleanup,
                    'foreign'
                );
                const scopes = [
                    fixture.input.organizationId,
                    foreign.input.organizationId,
                ];
                for (const input of [
                    {
                        ...fixture.input,
                        organizationId: foreign.input.organizationId,
                    },
                    {
                        ...fixture.input,
                        recipientId: foreign.input.recipientId,
                    },
                    {
                        ...fixture.input,
                        notificationId: foreign.input.notificationId,
                    },
                    { ...fixture.input, deliveryId: foreign.input.deliveryId },
                    { ...fixture.input, leaseToken: randomUUID() },
                ]) {
                    const before = await pushRegistrationSnapshot(scopes);
                    let calls = 0;
                    const result = await sendNotificationPush(
                        prisma,
                        input,
                        new Date(),
                        {
                            sendNotification: () => {
                                calls++;
                                return Promise.resolve(acceptedPushResponse);
                            },
                        }
                    );
                    assert.equal(result.sent, false);
                    assert.equal(calls, 0);
                    await assertPushRegistrationUnchanged(scopes, before);
                }
            }
        );

        await t.test(
            'invalid operator configuration fails before every sender without mass subscription revocation',
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    'invalid-policy'
                );
                const before = await pushRegistrationSnapshot([
                    fixture.input.organizationId,
                ]);
                let calls = 0;
                process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS = '';
                try {
                    await assert.rejects(
                        sendNotificationPush(
                            prisma,
                            fixture.input,
                            new Date(),
                            {
                                sendNotification: () => {
                                    calls++;
                                    return Promise.resolve(
                                        acceptedPushResponse
                                    );
                                },
                            }
                        ),
                        PushEndpointPolicyConfigurationError
                    );
                } finally {
                    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
                }
                assert.equal(calls, 0);
                await assertPushRegistrationUnchanged(
                    [fixture.input.organizationId],
                    before
                );
            }
        );

        await t.test(
            'policy invalidation after one accepted device stops further requests without retrying or revoking the devices',
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    'policy-changed-after-send'
                );
                const secondBefore =
                    await prisma.vectorixPushSubscription.findUniqueOrThrow({
                        where: { id: fixture.devices[1]!.id },
                    });
                let calls = 0;
                try {
                    const result = await sendNotificationPush(
                        prisma,
                        fixture.input,
                        new Date(),
                        {
                            sendNotification: () => {
                                calls++;
                                if (calls === 1)
                                    process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS =
                                        '';
                                return Promise.resolve(acceptedPushResponse);
                            },
                        }
                    );
                    assert.equal(result.sent, true);
                } finally {
                    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
                }
                assert.equal(calls, 1);
                assert.ok(
                    isDeepStrictEqual(
                        await prisma.vectorixPushSubscription.findUniqueOrThrow(
                            { where: { id: fixture.devices[1]!.id } }
                        ),
                        secondBefore
                    ),
                    'The unsent second device must remain unchanged after invalid configuration.'
                );
                const first =
                    await prisma.vectorixPushSubscription.findUniqueOrThrow({
                        where: { id: fixture.devices[0]!.id },
                    });
                assert.equal(first.revokedAt, null);
                assert.equal(first.version, 1);
                assert.ok(first.lastUsedAt);
            }
        );

        await pushProviderIntegrationTests(t, cleanup);
    } finally {
        restore();
    }
}
