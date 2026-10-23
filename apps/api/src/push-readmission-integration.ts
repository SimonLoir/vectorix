import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { prisma } from '@repo/db';
import { loadPushDispatch } from '../../workers/src/notifications/push-admission';
import { sendNotificationPush } from '../../workers/src/notifications/push';
import type { PushFixtureCleanup } from './push-subscription-fixtures';
import {
    acceptedPushResponse,
    createPushDeliveryFixture,
    disablePushPreference,
    type PushDeliveryFixture,
} from './push-delivery-fixtures';

type Change = Readonly<{
    name: string;
    apply: (fixture: PushDeliveryFixture) => Promise<unknown>;
}>;

const changes: readonly Change[] = [
    {
        name: 'a native device revocation',
        apply: (fixture) =>
            fixture.recipient.client.admin.notifications.pushSubscriptions.revoke(
                {
                    id: fixture.devices[1]!.id,
                    expectedOrganizationId: fixture.input.organizationId,
                    expectedVersion: fixture.devices[1]!.version,
                }
            ),
    },
    {
        name: 'a native device version rotation',
        apply: (fixture) =>
            fixture.recipient.client.admin.notifications.pushSubscriptions.register(
                fixture.devices[1]!.registration
            ),
    },
    {
        name: 'an expired device',
        apply: (fixture) =>
            prisma.vectorixPushSubscription.update({
                where: { id: fixture.devices[1]!.id },
                data: { expirationTime: new Date(Date.now() - 1) },
            }),
    },
    { name: 'a disabled native PUSH preference', apply: disablePushPreference },
    {
        name: 'a suspended organization',
        apply: (fixture) =>
            prisma.organization.update({
                where: { id: fixture.input.organizationId },
                data: { isActive: false },
            }),
    },
    {
        name: 'an invalidated source identity',
        apply: (fixture) =>
            prisma.vectorixNotification.update({
                where: { id: fixture.input.notificationId },
                data: {
                    sourceId: JSON.stringify([randomUUID(), randomUUID()]),
                },
            }),
    },
    {
        name: 'an unsupported source version',
        apply: (fixture) =>
            prisma.vectorixNotification.update({
                where: { id: fixture.input.notificationId },
                data: { sourceVersion: 2 },
            }),
    },
    {
        name: 'an unsupported source kind',
        apply: (fixture) =>
            prisma.vectorixNotification.update({
                where: { id: fixture.input.notificationId },
                data: { sourceKind: 'UNSUPPORTED_FIXTURE_SOURCE' },
            }),
    },
    {
        name: 'a replaced delivery lease',
        apply: (fixture) =>
            prisma.vectorixNotificationDelivery.update({
                where: { id: fixture.input.deliveryId },
                data: { leaseToken: randomUUID() },
            }),
    },
    {
        name: 'an expired delivery lease',
        apply: (fixture) =>
            prisma.vectorixNotificationDelivery.update({
                where: { id: fixture.input.deliveryId },
                data: { leasedUntil: new Date(Date.now() - 1) },
            }),
    },
];

/** Wait for the real saved deadline, tolerating early timer wakeups within a strict three-second bound. */
async function waitPastAdmissionDeadline(deadline: Date) {
    const target = deadline.getTime() + 20;
    const started = performance.now();
    let wakeups = 0;
    while (Date.now() < target) {
        const remainingBudget = 3000 - (performance.now() - started);
        assert.ok(
            remainingBudget > 0 && wakeups++ < 64,
            'The natural expiry observation must finish within its bounded wait.'
        );
        await setTimeout(Math.min(target - Date.now(), remainingBudget));
    }
    assert.ok(
        performance.now() - started <= 3000,
        'The natural expiry observation exceeded its three-second wait bound.'
    );
}

/** Each change commits after the first injected send; stale admission must not authorize a second device. */
export async function pushReadmissionIntegrationTests(
    t: TestContext,
    cleanup: PushFixtureCleanup
) {
    for (const change of changes) {
        await t.test(
            `fresh device admission observes ${change.name} committed after the first send`,
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    change.name
                );
                let calls = 0;
                const result = await sendNotificationPush(
                    prisma,
                    fixture.input,
                    new Date(),
                    {
                        sendNotification: async (subscription) => {
                            calls++;
                            assert.ok(
                                subscription.endpoint ===
                                    fixture.devices[0]!.registration.endpoint,
                                'A stale second device must not dispatch.'
                            );
                            if (calls === 1) await change.apply(fixture);
                            return acceptedPushResponse;
                        },
                    }
                );
                assert.equal(
                    result.sent,
                    true,
                    'An already acknowledged first request remains sent.'
                );
                assert.equal(calls, 1);
                assert.equal(
                    (
                        await prisma.vectorixPushSubscription.findUniqueOrThrow(
                            { where: { id: fixture.devices[1]!.id } }
                        )
                    ).lastUsedAt,
                    null
                );
            }
        );
    }

    for (const deadlineKind of ['lease', 'device'] as const) {
        await t.test(
            `a ${deadlineKind} deadline reached after the real admission snapshot prevents dispatch`,
            async () => {
                const fixture = await createPushDeliveryFixture(
                    cleanup,
                    `delayed-${deadlineKind}-admission`
                );
                const deadline = new Date(Date.now() + 2000);
                await (deadlineKind === 'lease'
                    ? prisma.vectorixNotificationDelivery.update({
                          where: { id: fixture.input.deliveryId },
                          data: { leasedUntil: deadline },
                      })
                    : prisma.vectorixPushSubscription.updateMany({
                          where: {
                              id: {
                                  in: fixture.devices.map(
                                      (device) => device.id
                                  ),
                              },
                              organizationId: fixture.input.organizationId,
                              recipientId: fixture.input.recipientId,
                          },
                          data: { expirationTime: deadline },
                      }));

                let admissions = 0;
                let expiredAdmissions = 0;
                let sends = 0;
                const result = await sendNotificationPush(
                    prisma,
                    fixture.input,
                    new Date(),
                    {
                        loadDispatch: async (db, input, candidate, now) => {
                            admissions++;
                            const admitted = await loadPushDispatch(
                                db,
                                input,
                                candidate,
                                now
                            );
                            if (admissions === 1) {
                                assert.ok(
                                    admitted !== null,
                                    'The first real admission must succeed before expiry.'
                                );
                                const savedDeadline =
                                    deadlineKind === 'lease'
                                        ? admitted.leasedUntil
                                        : admitted.subscription.expirationTime;
                                assert.ok(
                                    savedDeadline !== null &&
                                        savedDeadline.getTime() ===
                                            deadline.getTime() &&
                                        savedDeadline.getTime() > Date.now(),
                                    'The real snapshot must contain the exact future fixture deadline.'
                                );
                                await waitPastAdmissionDeadline(deadline);
                            } else {
                                assert.equal(
                                    admitted,
                                    null,
                                    'The other candidate must fail real admission after expiry.'
                                );
                                expiredAdmissions++;
                            }
                            return admitted;
                        },
                        sendNotification: () => {
                            sends++;
                            return Promise.resolve(acceptedPushResponse);
                        },
                    }
                );
                assert.equal(result.sent, false);
                assert.equal(sends, 0);
                assert.equal(admissions, 2);
                assert.equal(expiredAdmissions, 1);
                const devices = await prisma.vectorixPushSubscription.findMany({
                    where: {
                        id: { in: fixture.devices.map((device) => device.id) },
                    },
                    select: { lastUsedAt: true, revokedAt: true },
                });
                assert.ok(
                    devices.length === 2 &&
                        devices.every(
                            (device) =>
                                device.lastUsedAt === null &&
                                device.revokedAt === null
                        ),
                    'Expiry admission must not dispatch, revoke, or record device usage.'
                );
            }
        );
    }

    await t.test(
        'native removal of an ordinary recipient between devices prevents the second dispatch',
        async () => {
            const fixture = await createPushDeliveryFixture(
                cleanup,
                'removed-member',
                true
            );
            let calls = 0;
            const result = await sendNotificationPush(
                prisma,
                fixture.input,
                new Date(),
                {
                    sendNotification: async () => {
                        calls++;
                        if (calls === 1)
                            await fixture.owner.native(
                                'organization/remove-member',
                                {
                                    organizationId:
                                        fixture.input.organizationId,
                                    memberIdOrEmail: fixture.recipient.memberId,
                                }
                            );
                        return acceptedPushResponse;
                    },
                }
            );
            assert.equal(result.sent, true);
            assert.equal(calls, 1);
            assert.equal(
                await prisma.member.count({
                    where: { id: fixture.recipient.memberId },
                }),
                0
            );
            assert.equal(
                await prisma.vectorixPushSubscription.count({
                    where: {
                        id: {
                            in: fixture.devices.map((device) => device.id),
                        },
                    },
                }),
                0
            );
        }
    );
}
