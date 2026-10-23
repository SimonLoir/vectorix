import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { initializeVectorixPermissions } from '@repo/auth/permissions/rollout';
import { enqueueAccountSignInNotifications } from '@routers/utils/notifications';
import { processNotifications } from '../../workers/src/notifications/process';
import { app } from './app';
import { apiKeyIssuerRevocationTests } from './api-key-issuer-revocation';
import { requestBodyIntegrationTests } from './request-body-integration';
import { passwordResetIntegrationTests } from './password-reset-integration';
import { superadminTransactionIntegrationTests } from './superadmin-transaction-integration';
import { cookieCsrfIntegrationTests } from './cookie-csrf-integration';

if (
    !new URL(
        process.env.DATABASE_URL ?? 'postgresql://localhost/'
    ).pathname.endsWith('_test')
) {
    throw new Error(
        'Integration tests require a separate DATABASE_URL ending in _test.'
    );
}
// Integration runs never contact external mail, push or licensing providers.
for (const key of [
    'VECTORIX_DEFAULT_RESEND_API_KEY',
    'VECTORIX_DEFAULT_SMTP_HOST',
    'VECTORIX_FEATURE_PROVIDER_URL',
])
    process.env[key] = '';
process.env.VECTORIX_WEB_PUSH_ENABLED = 'false';
const runId = randomUUID().slice(0, 8);
const userIds: string[] = [];
const organizationIds: string[] = [];
const featureIds: string[] = [];
const password = 'Local-test-password-928!';

function browser() {
    const cookies = new Map<string, string>();
    const headers = (extra: Record<string, string> = {}) => ({
        origin: 'http://localhost:3000',
        cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
        ...extra,
    });
    async function post(path: string, body: unknown) {
        const response = await app.request(
            `http://localhost:3001/api/auth/${path}`,
            {
                method: 'POST',
                headers: headers({ 'content-type': 'application/json' }),
                body: JSON.stringify(body),
            }
        );
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]!;
            const index = pair.indexOf('=');
            cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
        const payload = await response.json();
        assert.ok(response.ok, `${path}: ${JSON.stringify(payload)}`);
        return payload;
    }
    function client(extra: Record<string, string> = {}): VectorixApiV1Client {
        return createORPCClient(
            new RPCLink({
                url: 'http://localhost:3001/rpc/v1',
                headers: () => headers(extra),
                fetch: (request) => Promise.resolve(app.request(request)),
            })
        );
    }
    return { post, client, headers };
}
const a = browser();
const b = browser();

// Only rows created by this run are removed; an existing development database is never accepted.
after(async () => {
    await prisma.superAdminAuditLog.deleteMany({
        where: { userId: { in: userIds } },
    });
    await prisma.apikey.deleteMany({
        where: { referenceId: { in: organizationIds } },
    });
    await prisma.organization.deleteMany({
        where: { id: { in: organizationIds } },
    });
    await prisma.vectorixFeatureDefinition.deleteMany({
        where: { id: { in: featureIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

void test('core journeys with real PostgreSQL and the HTTP transports', async (t) => {
    await initializeVectorixPermissions();
    await t.test('account creation and organization creation', async () => {
        for (const [index, session] of [a, b].entries()) {
            const account = await session.post('sign-up/email', {
                name: `Template ${index}`,
                email: `${runId}-${index}@example.test`,
                password,
            });
            userIds.push(account.user.id);
            const organization = await session.post('organization/create', {
                name: `Workspace ${index}`,
                slug: `test-${runId}-${index}`,
            });
            organizationIds.push(organization.id);
            await session.post('organization/set-active', {
                organizationId: organization.id,
            });
        }
        assert.equal(
            (await a.client().admin.members.me({})).userId,
            userIds[0]
        );
        assert.equal(
            (await b.client().admin.members.me({})).organizationId,
            organizationIds[1]
        );
    });
    await t.test(
        'tenant pinning and superadmin access fail closed',
        async () => {
            await assert.rejects(
                a
                    .client({
                        'Vectorix-Expected-Organization-Id':
                            organizationIds[1]!,
                    })
                    .admin.organization.access({}),
                { code: 'CONFLICT' }
            );
            await assert.rejects(a.client().superadmin.me({}), {
                code: 'FORBIDDEN',
            });
            await prisma.user.update({
                where: { id: userIds[0] },
                data: { isSuperAdmin: true },
            });
            assert.equal(
                (await a.client().superadmin.me({})).user.isSuperAdmin,
                true
            );
            assert.ok(
                (await a.client().superadmin.dashboard({}))
                    .organizationsTotal >= 2
            );
            assert.equal(
                (
                    await a.client().superadmin.organizations.get({
                        organizationId: organizationIds[0]!,
                    })
                ).members.length,
                1
            );
        }
    );
    await t.test(
        'scoped API keys authenticate without gaining user or admin access',
        async () => {
            const key = await a.client().admin.organization.apiKeys.create({
                name: 'Read settings',
                permissions: { settings: ['read'] },
            });
            const client: VectorixApiV1Client = createORPCClient(
                new RPCLink({
                    url: 'http://localhost:3001/rpc/v1',
                    headers: { 'x-api-key': key.key },
                    fetch: (request) => Promise.resolve(app.request(request)),
                })
            );
            assert.equal(
                (await client.admin.organization.get({})).id,
                organizationIds[0]
            );
            await assert.rejects(client.admin.members.me({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(client.admin.notifications.list({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(client.superadmin.me({}), {
                code: 'FORBIDDEN',
            });
            const stored = await prisma.apikey.findUniqueOrThrow({
                where: { id: key.id },
            });
            assert.notEqual(stored.key, key.key);
            assert.equal(stored.vectorixLegacyFullAccess, false);
        }
    );
    await t.test(
        'licensed features require an explicit grant and expire immediately',
        async () => {
            const feature = await a.client().superadmin.features.create({
                key: `reporting-${runId}`,
                name: 'Reporting',
                defaultEnabled: true,
            });
            featureIds.push(feature.id);
            const organizationId = organizationIds[0]!;
            assert.equal(
                (
                    await a.client().admin.organization.features({})
                ).features.find((item) => item.id === feature.id)?.enabled,
                false
            );
            await a.client().superadmin.organizations.setLegacyAccess({
                organizationId,
                enabled: true,
            });
            await a.client().superadmin.organizations.setFeatureOverride({
                organizationId,
                featureId: feature.id,
                enabled: true,
            });
            assert.equal(
                (
                    await a.client().admin.organization.features({})
                ).features.find((item) => item.id === feature.id)?.enabled,
                true
            );
            await a.client().superadmin.organizations.setFeatureOverride({
                organizationId,
                featureId: feature.id,
                enabled: true,
                expiresAt: new Date(Date.now() - 1000),
            });
            assert.equal(
                (
                    await a.client().admin.organization.features({})
                ).features.find((item) => item.id === feature.id)?.enabled,
                false
            );
            assert.ok(
                (await a.client().superadmin.audit.list({})).logs.length >= 3
            );
        }
    );
    await t.test(
        'notification preferences, deduplication, isolation and read state',
        async () => {
            const organizationId = organizationIds[0]!;
            const preferences = await a
                .client()
                .admin.notifications.preferences.get({});
            await a.client().admin.notifications.preferences.update({
                expectedOrganizationId: organizationId,
                changes: preferences.preferences.map((item) => ({
                    eventType: item.eventType,
                    channel: item.channel,
                    enabled: item.channel !== 'PUSH',
                    expectedVersion: item.version,
                })),
            });
            const input = {
                userId: userIds[0]!,
                sessionId: randomUUID(),
                activeOrganizationId: organizationId,
                occurredAt: new Date(),
                ipAddress: '127.0.0.1',
                userAgent: 'Firefox/128 Linux',
            };
            assert.equal(
                (await enqueueAccountSignInNotifications(prisma, input))
                    .enqueued,
                true
            );
            assert.equal(
                (await enqueueAccountSignInNotifications(prisma, input))
                    .enqueued,
                false
            );
            const list = await a.client().admin.notifications.list({});
            assert.equal(list.notifications.length, 1);
            assert.equal(
                (await a.client().admin.notifications.unreadCount({})).count,
                1
            );
            assert.equal(
                (await b.client().admin.notifications.list({})).notifications
                    .length,
                0
            );
            await assert.rejects(
                b.client().admin.notifications.markRead({
                    id: list.notifications[0]!.id,
                    expectedOrganizationId: organizationIds[1]!,
                }),
                { code: 'NOT_FOUND' }
            );
            await a.client().admin.notifications.markRead({
                id: list.notifications[0]!.id,
                expectedOrganizationId: organizationId,
            });
            assert.equal(
                (await a.client().admin.notifications.unreadCount({})).count,
                0
            );
            await processNotifications(prisma);
            const pendingEmail =
                await prisma.vectorixNotificationDelivery.findFirstOrThrow({
                    where: { organizationId, channel: 'EMAIL' },
                });
            assert.equal(pendingEmail.status, 'PENDING');
            assert.equal(pendingEmail.attempts, 1);
            await prisma.vectorixNotificationDelivery.update({
                where: { id: pendingEmail.id },
                data: { availableAt: new Date() },
            });
            const current = await a
                .client()
                .admin.notifications.preferences.get({});
            await a.client().admin.notifications.preferences.update({
                expectedOrganizationId: organizationId,
                changes: [
                    {
                        eventType: 'ACCOUNT_SIGN_IN',
                        channel: 'EMAIL',
                        enabled: false,
                        expectedVersion: current.preferences.find(
                            (item) => item.channel === 'EMAIL'
                        )!.version,
                    },
                ],
            });
            await processNotifications(prisma);
            assert.equal(
                (
                    await prisma.vectorixNotificationDelivery.findFirstOrThrow({
                        where: { organizationId, channel: 'EMAIL' },
                    })
                ).status,
                'SKIPPED'
            );
            await assert.rejects(
                a.client().admin.notifications.preferences.update({
                    expectedOrganizationId: organizationId,
                    changes: [
                        {
                            eventType: 'ACCOUNT_SIGN_IN',
                            channel: 'EMAIL',
                            enabled: true,
                            expectedVersion: null,
                        },
                    ],
                }),
                { code: 'CONFLICT' }
            );
        }
    );
    await t.test(
        'suspending an organization revokes its API access',
        async () => {
            const organizationId = organizationIds[0]!;
            await a.client().superadmin.organizations.update({
                organizationId,
                isActive: false,
            });
            await assert.rejects(a.client().admin.organization.get({}), {
                code: 'FORBIDDEN',
            });
            await a.client().superadmin.organizations.update({
                organizationId,
                isActive: true,
            });
            assert.equal(
                (await a.client().admin.organization.get({})).id,
                organizationId
            );
        }
    );
    await cookieCsrfIntegrationTests(t, {
        owner: a,
        foreign: b,
        organizationId: organizationIds[0]!,
        foreignOrganizationId: organizationIds[1]!,
    });
    await apiKeyIssuerRevocationTests(t, {
        owner: a,
        foreign: b,
        createBrowser: browser,
        organizationId: organizationIds[0]!,
        foreignOrganizationId: organizationIds[1]!,
        registerUser: (id) => userIds.push(id),
    });
    await requestBodyIntegrationTests(t, {
        owner: a,
        organizationId: organizationIds[0]!,
    });
    await passwordResetIntegrationTests(t, {
        createBrowser: browser,
        registerUser: (id) => userIds.push(id),
    });
    await superadminTransactionIntegrationTests(t, {
        createBrowser: browser,
        foreignOrganizationId: organizationIds[1]!,
        registerUser: (id) => userIds.push(id),
        registerOrganization: (id) => organizationIds.push(id),
        registerFeature: (id) => featureIds.push(id),
    });
});
