import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@repo/db';
import { sendNotificationPush } from '../../workers/src/notifications/push';
import { PushDeliveryFailure } from '../../workers/src/notifications/push-failure';
import {
    assertPushRegistrationUnchanged,
    pushRegistrationSnapshot,
    type PushFixtureCleanup,
} from './push-subscription-fixtures';
import {
    acceptedPushResponse,
    createPushDeliveryFixture,
} from './push-delivery-fixtures';

/** Provider outcomes are injected locally; no network or processor retry is executed here. */
export async function pushProviderIntegrationTests(
    t: TestContext,
    cleanup: PushFixtureCleanup
) {
    for (const statusCode of [404, 410]) {
        await t.test(
            `provider ${statusCode} revokes only the exact registered device versions`,
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    `gone-${statusCode}`
                );
                let calls = 0;
                const result = await sendNotificationPush(
                    prisma,
                    fixture.input,
                    new Date(),
                    {
                        sendNotification: () => {
                            calls++;
                            return Promise.reject(
                                Object.assign(
                                    new Error('PRIVATE_PROVIDER_SENTINEL'),
                                    {
                                        statusCode,
                                        body: 'PRIVATE_PROVIDER_SENTINEL',
                                    }
                                )
                            );
                        },
                    }
                );
                assert.equal(result.sent, false);
                assert.equal(calls, 2);
                const devices = await prisma.vectorixPushSubscription.findMany({
                    where: {
                        id: {
                            in: fixture.devices.map((device) => device.id),
                        },
                    },
                });
                assert.ok(
                    devices.every(
                        (device) =>
                            device.revokedAt !== null &&
                            device.version === 2 &&
                            device.lastUsedAt === null
                    )
                );
            }
        );
    }

    await t.test(
        'a late gone response cannot revoke a subscription rotated while its first request was in flight',
        async () => {
            const fixture = await createPushDeliveryFixture(
                cleanup,
                'gone-rotation'
            );
            let calls = 0;
            const result = await sendNotificationPush(
                prisma,
                fixture.input,
                new Date(),
                {
                    sendNotification: async () => {
                        calls++;
                        if (calls === 1) {
                            await fixture.recipient.client.admin.notifications.pushSubscriptions.register(
                                fixture.devices[0]!.registration
                            );
                            throw Object.assign(
                                new Error('PRIVATE_PROVIDER_SENTINEL'),
                                {
                                    statusCode: 410,
                                    body: 'PRIVATE_PROVIDER_SENTINEL',
                                }
                            );
                        }
                        return acceptedPushResponse;
                    },
                }
            );
            assert.equal(result.sent, true);
            assert.equal(calls, 2);
            const first =
                await prisma.vectorixPushSubscription.findUniqueOrThrow({
                    where: { id: fixture.devices[0]!.id },
                });
            assert.equal(first.version, 2);
            assert.equal(first.revokedAt, null);
            assert.equal(first.lastUsedAt, null);
        }
    );

    await t.test(
        'provider rate-limit failures expose only bounded diagnostics and preserve the durable retry receipt',
        async () => {
            const fixture = await createPushDeliveryFixture(
                cleanup,
                'rate-limit'
            );
            const before = await pushRegistrationSnapshot([
                fixture.input.organizationId,
            ]);
            const receipt =
                await prisma.vectorixNotificationDelivery.findUniqueOrThrow({
                    where: { id: fixture.input.deliveryId },
                });
            let calls = 0;
            let captured: unknown;
            try {
                await sendNotificationPush(prisma, fixture.input, new Date(), {
                    sendNotification: () => {
                        calls++;
                        return Promise.reject(
                            Object.assign(
                                new Error('PRIVATE_PROVIDER_SENTINEL'),
                                {
                                    statusCode: 429,
                                    body: 'PRIVATE_PROVIDER_SENTINEL',
                                }
                            )
                        );
                    },
                });
            } catch (error) {
                captured = error;
            }
            assert.ok(captured instanceof PushDeliveryFailure);
            assert.equal(captured.category, 'PROVIDER_RATE_LIMIT');
            assert.equal(captured.providerHttpStatus, 429);
            assert.equal(captured.providerMessage, null);
            assert.equal(captured.cause, undefined);
            assert.equal(
                captured.message,
                'Web Push delivery failed: PROVIDER_RATE_LIMIT'
            );
            assert.equal(calls, 2);
            await assertPushRegistrationUnchanged(
                [fixture.input.organizationId],
                before
            );
            assert.ok(
                isDeepStrictEqual(
                    await prisma.vectorixNotificationDelivery.findUniqueOrThrow(
                        { where: { id: fixture.input.deliveryId } }
                    ),
                    receipt
                ),
                'The sender must leave retry transitions to the existing processor.'
            );
        }
    );
}
