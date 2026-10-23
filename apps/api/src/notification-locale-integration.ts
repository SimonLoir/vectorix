import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { enqueueAccountSignInNotifications } from '@routers/utils/notifications';
import { z } from 'zod';
import { processNotifications } from '../../workers/src/notifications/process';
import { htmlPart, smtpCapture } from './email-ownership-tests/smtp';
import { app } from './app';

const environmentKeys = [
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_SMTP_HOST',
    'VECTORIX_DEFAULT_SMTP_PORT',
    'VECTORIX_DEFAULT_SMTP_USER',
    'VECTORIX_DEFAULT_SMTP_PASSWORD',
    'VECTORIX_DEFAULT_SMTP_SENDER_EMAIL',
] as const;
const origin = 'http://localhost:3000';
const identity = z.object({ id: z.string() });

/** Real native preference writes, durable notification rows and bounded loopback SMTP on the disposable test database. */
export async function notificationLocaleIntegrationTests(
    t: TestContext,
    fixture: {
        registerUser(id: string): void;
        registerOrganization(id: string): void;
    }
) {
    assert.ok(
        new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('_test')
    );
    const previous = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    const smtp = await smtpCapture();
    const run = randomUUID().slice(0, 8);
    let sequence = 0;
    delete process.env.VECTORIX_DEFAULT_RESEND_API_KEY;
    process.env.VECTORIX_DEFAULT_SMTP_HOST = '127.0.0.1';
    process.env.VECTORIX_DEFAULT_SMTP_PORT = String(smtp.port);
    delete process.env.VECTORIX_DEFAULT_SMTP_USER;
    delete process.env.VECTORIX_DEFAULT_SMTP_PASSWORD;
    process.env.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL = 'notices@example.test';

    async function account() {
        const cookies = new Map<string, string>();
        const headers = () => ({
            origin,
            cookie: [...cookies]
                .map(([key, value]) => `${key}=${value}`)
                .join('; '),
        });
        async function post(path: string, body: unknown): Promise<unknown> {
            const response = await app.request(
                `http://localhost:3001/api/auth/${path}`,
                {
                    method: 'POST',
                    headers: {
                        ...headers(),
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify(body),
                }
            );
            for (const header of response.headers.getSetCookie()) {
                const pair = header.split(';')[0]!;
                const separator = pair.indexOf('=');
                cookies.set(
                    pair.slice(0, separator),
                    pair.slice(separator + 1)
                );
            }
            assert.equal(response.status, 200, `Native ${path} must succeed.`);
            return response.json();
        }
        const email = `notice-${run}-${++sequence}@example.test`;
        const created = z.object({ user: identity }).parse(
            await post('sign-up/email', {
                name: 'Notification locale test',
                email,
                password: 'Notification-locale-test-928!',
            })
        );
        const userId = created.user.id;
        fixture.registerUser(userId);
        const organizationId = identity.parse(
            await post('organization/create', {
                name: 'Notification locale test',
                slug: `notice-${run}-${sequence}`,
            })
        ).id;
        fixture.registerOrganization(organizationId);
        await post('organization/set-active', { organizationId });
        const client: VectorixApiV1Client = createORPCClient(
            new RPCLink({
                url: 'http://localhost:3001/rpc/v1',
                headers,
                fetch: (request) => Promise.resolve(app.request(request)),
            })
        );
        const preferences = await client.admin.notifications.preferences.get(
            {}
        );
        await client.admin.notifications.preferences.update({
            expectedOrganizationId: organizationId,
            changes: preferences.preferences.map((item) => ({
                eventType: item.eventType,
                channel: item.channel,
                enabled: item.channel !== 'PUSH',
                expectedVersion: item.version,
            })),
        });
        return { userId, organizationId, email, post, client };
    }
    async function enqueue(owner: Awaited<ReturnType<typeof account>>) {
        const input = {
            userId: owner.userId,
            sessionId: randomUUID(),
            activeOrganizationId: owner.organizationId,
            occurredAt: new Date(),
            ipAddress: '127.0.0.1',
            userAgent: 'Firefox/128 Linux',
        };
        assert.equal(
            (await enqueueAccountSignInNotifications(prisma, input)).enqueued,
            true
        );
        assert.equal(
            (await enqueueAccountSignInNotifications(prisma, input)).enqueued,
            false
        );
    }
    try {
        await t.test(
            'saved native dashboard languages and legacy regional values reach inbox and real SMTP',
            async () => {
                for (const [saved, canonical, title, action] of [
                    [
                        'en',
                        'en',
                        'New sign-in to your account',
                        'Open my account',
                    ],
                    [
                        'fr',
                        'fr',
                        'Nouvelle connexion à votre compte',
                        'Ouvrir mon compte',
                    ],
                    [
                        'nl-BE',
                        'nl-BE',
                        'Nieuwe aanmelding op uw account',
                        'Mijn account openen',
                    ],
                    [
                        'en-US',
                        'en',
                        'New sign-in to your account',
                        'Open my account',
                    ],
                    [
                        'en-GB',
                        'en',
                        'New sign-in to your account',
                        'Open my account',
                    ],
                    [
                        'fr-CA',
                        'fr',
                        'Nouvelle connexion à votre compte',
                        'Ouvrir mon compte',
                    ],
                    [
                        null,
                        'en',
                        'New sign-in to your account',
                        'Open my account',
                    ],
                ] as const) {
                    const owner = await account();
                    // Historical regional/null values are fixtures only; native writes accept canonical values.
                    await (saved === canonical
                        ? owner.post('update-user', { locale: saved })
                        : prisma.user.update({
                              where: { id: owner.userId },
                              data: { locale: saved },
                          }));
                    await enqueue(owner);
                    const list = await owner.client.admin.notifications.list(
                        {}
                    );
                    assert.equal(list.notifications.length, 1);
                    assert.equal(list.notifications[0]!.title, title);
                    const before = smtp.messages.length;
                    await processNotifications(prisma);
                    assert.equal(smtp.messages.length, before + 1);
                    const mail = smtp.messages.at(-1)!;
                    assert.equal(mail.to, owner.email);
                    const html = htmlPart(mail.raw);
                    assert.ok(
                        html.includes(`lang="${canonical}"`),
                        'Mail language must match saved preference.'
                    );
                    assert.ok(
                        html.includes(action),
                        'Mail action must use the saved preference.'
                    );
                    assert.ok(
                        html.includes(title),
                        'Mail heading must use the saved preference.'
                    );
                    const delivery =
                        await prisma.vectorixNotificationDelivery.findFirstOrThrow(
                            {
                                where: {
                                    organizationId: owner.organizationId,
                                    channel: 'EMAIL',
                                },
                            }
                        );
                    assert.equal(delivery.status, 'SENT');
                    assert.equal(delivery.attempts, 1);
                    await processNotifications(prisma);
                    assert.equal(smtp.messages.length, before + 1);
                }
            }
        );
        await t.test(
            'delivery follows current personal language while inbox keeps its creation snapshot',
            async () => {
                const owner = await account();
                await owner.post('update-user', { locale: 'fr' });
                await enqueue(owner);
                await owner.post('update-user', { locale: 'nl-BE' });
                const before = smtp.messages.length;
                await processNotifications(prisma);
                assert.equal(smtp.messages.length, before + 1);
                const html = htmlPart(smtp.messages.at(-1)!.raw);
                assert.ok(html.includes('lang="nl-BE"'));
                assert.ok(html.includes('Mijn account openen'));
                const list = await owner.client.admin.notifications.list({});
                assert.equal(
                    list.notifications[0]!.title,
                    'Nouvelle connexion à votre compte'
                );
            }
        );
        await t.test(
            'a disabled email preference still skips a queued localized delivery',
            async () => {
                const owner = await account();
                await owner.post('update-user', { locale: 'en' });
                await enqueue(owner);
                const preferences =
                    await owner.client.admin.notifications.preferences.get({});
                const email = preferences.preferences.find(
                    (item) => item.channel === 'EMAIL'
                )!;
                await owner.client.admin.notifications.preferences.update({
                    expectedOrganizationId: owner.organizationId,
                    changes: [
                        {
                            eventType: 'ACCOUNT_SIGN_IN',
                            channel: 'EMAIL',
                            enabled: false,
                            expectedVersion: email.version,
                        },
                    ],
                });
                const before = smtp.messages.length;
                await processNotifications(prisma);
                assert.equal(smtp.messages.length, before);
                assert.equal(
                    (
                        await prisma.vectorixNotificationDelivery.findFirstOrThrow(
                            {
                                where: {
                                    organizationId: owner.organizationId,
                                    channel: 'EMAIL',
                                },
                            }
                        )
                    ).status,
                    'SKIPPED'
                );
            }
        );
        await t.test(
            'organization suspension skips pending external mail without sending',
            async () => {
                const owner = await account();
                await enqueue(owner);
                await prisma.organization.update({
                    where: { id: owner.organizationId },
                    data: { isActive: false },
                });
                const before = smtp.messages.length;
                await processNotifications(prisma);
                assert.equal(smtp.messages.length, before);
                const delivery =
                    await prisma.vectorixNotificationDelivery.findFirstOrThrow({
                        where: {
                            organizationId: owner.organizationId,
                            channel: 'EMAIL',
                        },
                        select: { status: true, sentAt: true, skippedAt: true },
                    });
                assert.equal(delivery.status, 'SKIPPED');
                assert.equal(delivery.sentAt, null);
                assert.ok(delivery.skippedAt);
            }
        );
        smtp.assertHealthy();
    } finally {
        await smtp.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}
