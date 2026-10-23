import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { app } from '../app';
import { totp } from '../email-ownership-tests/totp';
import {
    denied,
    localeBrowser,
    localeRequest,
    object,
    stringField,
    success,
} from './http';

type Fixture = {
    registerUser(id: string): void;
    registerOrganization(id: string): void;
};
const password = 'Locale-native-test-password-928!';

/** Native personal preference journeys use only the catalog's owned isolated database. */
export async function userLocaleIntegrationTests(t: TestContext, f: Fixture) {
    assert.ok(
        new URL(
            process.env.DATABASE_URL ?? 'postgresql://localhost/'
        ).pathname.endsWith('_test'),
        'Locale integration requires the isolated test database.'
    );
    const run = randomUUID().slice(0, 8);
    let sequence = 0;
    const users: string[] = [];
    async function account(label: string) {
        const browser = localeBrowser();
        const email = `locale-${run}-${++sequence}-${label}@example.test`;
        const result = success(
            await browser.request('sign-up/email', {
                name: `Locale ${label}`,
                email,
                password,
            })
        );
        const id = stringField(object(result.user).id);
        f.registerUser(id);
        users.push(id);
        return { id, email, browser };
    }
    async function snapshot() {
        const [accounts, sessions] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: users } },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    emailVerified: true,
                    isSuperAdmin: true,
                    twoFactorEnabled: true,
                    locale: true,
                    image: true,
                    updatedAt: true,
                },
                orderBy: { id: 'asc' },
            }),
            prisma.session.findMany({
                where: { userId: { in: users } },
                select: {
                    id: true,
                    userId: true,
                    activeOrganizationId: true,
                    expiresAt: true,
                },
                orderBy: { id: 'asc' },
            }),
        ]);
        return { accounts, sessions };
    }
    async function unchanged(before: Awaited<ReturnType<typeof snapshot>>) {
        assert.ok(
            isDeepStrictEqual(await snapshot(), before),
            'A denied locale request must leave owned users and session identities unchanged.'
        );
    }
    const own = await account('own');
    const foreign = await account('foreign');

    await t.test(
        'native signup rejects client locale input while new accounts use the English application default',
        async () => {
            assert.equal(
                (
                    await prisma.user.findUniqueOrThrow({
                        where: { id: own.id },
                        select: { locale: true },
                    })
                ).locale,
                'en'
            );
            assert.equal(
                object(success(await own.browser.request('get-session')).user)
                    .locale,
                'en'
            );
            for (const locale of ['fr', 'nl-BE', null]) {
                const email = `locale-${run}-${++sequence}-signup@example.test`;
                const before = await snapshot();
                denied(
                    await localeRequest('sign-up/email', {
                        name: 'Rejected locale signup',
                        email,
                        password,
                        locale,
                    }),
                    400,
                    'USER_LOCALE_UPDATE_REQUIRED'
                );
                assert.equal(await prisma.user.count({ where: { email } }), 0);
                await unchanged(before);
            }
        }
    );

    await t.test(
        'an own cookie session persists all canonical languages and exposes them through native session reads',
        async () => {
            for (const locale of ['fr', 'nl-BE', 'en']) {
                assert.equal(
                    success(
                        await own.browser.request('update-user', { locale })
                    ).status,
                    true
                );
                assert.equal(
                    (
                        await prisma.user.findUniqueOrThrow({
                            where: { id: own.id },
                            select: { locale: true },
                        })
                    ).locale,
                    locale
                );
                const session = success(
                    await own.browser.request(
                        'get-session?disableCookieCache=true'
                    )
                );
                assert.equal(object(session.user).id, own.id);
                assert.equal(object(session.user).locale, locale);
            }
            assert.equal(
                (
                    await prisma.user.findUniqueOrThrow({
                        where: { id: foreign.id },
                        select: { locale: true },
                    })
                ).locale,
                'en'
            );
        }
    );

    await t.test(
        'null, regional, unknown and malformed saved language inputs are rejected without writes',
        async () => {
            for (const locale of [
                null,
                'fr-BE',
                'EN',
                'nl',
                'de',
                '',
                ' fr ',
                1,
                {},
                ['fr'],
                'x'.repeat(256),
            ]) {
                const before = await snapshot();
                denied(
                    await own.browser.request('update-user', { locale }),
                    400,
                    'USER_LOCALE_INVALID'
                );
                await unchanged(before);
            }
        }
    );

    await t.test(
        'missing, malformed and revoked cookie sessions cannot save preferences',
        async () => {
            const missingHeaders: Record<string, string>[] = [
                {},
                { cookie: 'better-auth.session_token=invalid' },
            ];
            for (const headers of missingHeaders) {
                const before = await snapshot();
                denied(
                    await localeRequest(
                        'update-user',
                        { locale: 'fr' },
                        headers
                    ),
                    401,
                    'USER_LOCALE_SESSION_REQUIRED'
                );
                await unchanged(before);
            }
            const revoked = localeBrowser();
            success(
                await revoked.request('sign-in/email', {
                    email: own.email,
                    password,
                })
            );
            const nativeSession = object(
                success(await revoked.request('get-session')).session
            );
            const token = stringField(nativeSession.token);
            success(await own.browser.request('revoke-session', { token }));
            const before = await snapshot();
            denied(
                await revoked.request('update-user', { locale: 'fr' }),
                401,
                'USER_LOCALE_SESSION_REQUIRED'
            );
            await unchanged(before);
            denied(
                await localeRequest(
                    'update-user',
                    { locale: 'fr' },
                    { authorization: `Bearer ${token}` }
                ),
                401,
                'USER_LOCALE_SESSION_REQUIRED'
            );
            await unchanged(before);
        }
    );

    await t.test(
        'spoofed identifiers and undeclared sensitive fields cannot change another user or elevate the caller',
        async () => {
            const before = await snapshot();
            assert.equal(
                success(
                    await own.browser.request('update-user', {
                        locale: 'fr',
                        id: foreign.id,
                        userId: foreign.id,
                        emailVerified: true,
                        isSuperAdmin: true,
                        activeOrganizationId:
                            'foreign-scope-is-not-a-user-field',
                    })
                ).status,
                true
            );
            const after = await snapshot();
            const previousOwn = before.accounts.find(
                (user) => user.id === own.id
            )!;
            const currentOwn = after.accounts.find(
                (user) => user.id === own.id
            )!;
            assert.equal(currentOwn.locale, 'fr');
            assert.ok(
                isDeepStrictEqual(
                    {
                        ...currentOwn,
                        locale: previousOwn.locale,
                        updatedAt: previousOwn.updatedAt,
                    },
                    previousOwn
                ),
                'Locale updates must preserve sensitive current-user fields.'
            );
            assert.ok(
                isDeepStrictEqual(
                    after.accounts.find((user) => user.id === foreign.id),
                    before.accounts.find((user) => user.id === foreign.id)
                ),
                'Spoofed user identifiers must not affect the foreign account.'
            );
            assert.ok(
                isDeepStrictEqual(after.sessions, before.sessions),
                'An update body cannot retarget the active organization.'
            );
            const beforeDenied = await snapshot();
            const twoFactor = await own.browser.request('update-user', {
                locale: 'nl-BE',
                twoFactorEnabled: true,
            });
            assert.equal(twoFactor.response.status, 400);
            await unchanged(beforeDenied);
            const email = await own.browser.request('update-user', {
                locale: 'nl-BE',
                email: foreign.email,
            });
            assert.equal(email.response.status, 400);
            await unchanged(beforeDenied);
            const image = await own.browser.request('update-user', {
                locale: 'nl-BE',
                image: 'https://image.example.test/disabled',
            });
            assert.equal(image.response.status, 400);
            await unchanged(beforeDenied);
        }
    );

    await t.test(
        'a pending real two-factor challenge cannot update locale and a completed challenge can',
        async () => {
            const target = await account('two-factor');
            const enabled = success(
                await target.browser.request('two-factor/enable', { password })
            );
            let enrollment: URL;
            try {
                enrollment = new URL(stringField(enabled.totpURI));
            } catch {
                assert.fail('The native TOTP enrollment URL must be valid.');
            }
            const secret = enrollment.searchParams.get('secret');
            assert.ok(
                secret,
                'The native enable response must contain its TOTP secret.'
            );
            success(
                await target.browser.request('two-factor/verify-totp', {
                    code: totp(secret),
                })
            );
            const pending = localeBrowser();
            assert.equal(
                success(
                    await pending.request('sign-in/email', {
                        email: target.email,
                        password,
                    })
                ).twoFactorRedirect,
                true
            );
            assert.equal((await pending.request('get-session')).body, null);
            const before = await snapshot();
            denied(
                await pending.request('update-user', { locale: 'fr' }),
                401,
                'USER_LOCALE_SESSION_REQUIRED'
            );
            await unchanged(before);
            success(
                await pending.request('two-factor/verify-totp', {
                    code: totp(secret),
                })
            );
            success(await pending.request('update-user', { locale: 'fr' }));
            success(
                await pending.request('update-user', {
                    locale: 'nl-BE',
                    twoFactorEnabled: false,
                })
            );
            const saved = await prisma.user.findUniqueOrThrow({
                where: { id: target.id },
                select: { locale: true, twoFactorEnabled: true },
            });
            assert.equal(saved.locale, 'nl-BE');
            assert.equal(saved.twoFactorEnabled, true);
        }
    );

    await t.test(
        'a functioning organization API key cannot act as a personal cookie session',
        async () => {
            const owner = await account('key-owner');
            const created = success(
                await owner.browser.request('organization/create', {
                    name: 'Locale key isolation',
                    slug: `locale-key-${run}`,
                })
            );
            const organizationId = stringField(created.id);
            f.registerOrganization(organizationId);
            success(
                await owner.browser.request('organization/set-active', {
                    organizationId,
                })
            );
            const key = await owner.browser
                .client()
                .admin.organization.apiKeys.create({
                    name: 'Locale read key',
                    permissions: { settings: ['read'] },
                });
            const keyClient: VectorixApiV1Client = createORPCClient(
                new RPCLink({
                    url: 'http://localhost:3001/rpc/v1',
                    headers: { 'x-api-key': key.key },
                    fetch: (request) => Promise.resolve(app.request(request)),
                })
            );
            assert.equal(
                (await keyClient.admin.organization.get({})).id,
                organizationId
            );
            const before = await snapshot();
            denied(
                await localeRequest(
                    'update-user',
                    { locale: 'fr' },
                    { 'x-api-key': key.key }
                ),
                401,
                'USER_LOCALE_SESSION_REQUIRED'
            );
            await unchanged(before);
        }
    );
}
