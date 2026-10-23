import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { totp } from './email-ownership-tests/totp';
import {
    localeBrowser,
    object,
    stringField,
    success,
} from './user-locale-tests/http';

type Fixture = {
    registerUser(id: string): void;
    registerOrganization(id: string): void;
};
type Browser = ReturnType<typeof localeBrowser>;
const password = 'Initial-organization-native-test-928!';
const older = new Date('2020-01-01T00:00:00.000Z');
const newer = new Date('2021-01-01T00:00:00.000Z');

/** Exercise the production creation hook through native HTTP, never by calling its resolver. */
export async function sessionOrganizationIntegrationTests(
    t: TestContext,
    f: Fixture
) {
    assert.ok(
        new URL(
            process.env.DATABASE_URL ?? 'postgresql://localhost/'
        ).pathname.endsWith('_test'),
        'Native session organization tests require the isolated test database.'
    );
    const run = randomUUID().slice(0, 8);
    let sequence = 0;

    async function account(label: string) {
        const browser = localeBrowser();
        const email = `session-org-${run}-${++sequence}-${label}@example.test`;
        const result = success(
            await browser.request('sign-up/email', {
                name: `Session organization ${label}`,
                email,
                password,
            })
        );
        const id = stringField(object(result.user).id);
        f.registerUser(id);
        return { id, email, browser };
    }

    async function organization(
        label: string,
        isActive = true,
        createdAt = older
    ) {
        const id = randomUUID();
        f.registerOrganization(id);
        await prisma.organization.create({
            data: {
                id,
                name: `Session organization ${label}`,
                slug: `session-org-${run}-${id}`,
                createdAt,
                isActive,
            },
        });
        return id;
    }

    async function membership(
        userId: string,
        organizationId: string,
        createdAt = older,
        id: string = randomUUID()
    ) {
        await prisma.member.create({
            data: { id, userId, organizationId, createdAt, role: 'owner' },
        });
        return id;
    }

    async function readSession(browser: Browser) {
        const result = success(await browser.request('get-session'));
        const session = object(result.session);
        return {
            id: stringField(session.id),
            userId: stringField(object(result.user).id),
            activeOrganizationId: session.activeOrganizationId,
        };
    }

    async function signIn(email: string) {
        const browser = localeBrowser();
        success(await browser.request('sign-in/email', { email, password }));
        return browser;
    }

    async function assertSelection(browser: Browser, organizationId: string) {
        assert.equal(
            (await readSession(browser)).activeOrganizationId,
            organizationId
        );
        assert.equal(
            (await browser.client().admin.organization.get({})).id,
            organizationId
        );
        assert.equal(
            (await browser.client().admin.members.me({})).organizationId,
            organizationId
        );
    }

    async function assertAccountOnly(browser: Browser, userId: string) {
        const session = await readSession(browser);
        assert.equal(session.userId, userId);
        assert.equal(session.activeOrganizationId, null);
        const sessions = await browser.request('list-sessions');
        assert.equal(sessions.response.status, 200);
        assert.ok(
            Array.isArray(sessions.body) &&
                sessions.body.some(
                    (item: unknown) => object(item).id === session.id
                ),
            'An account-only user must still be able to read their native sessions.'
        );
        await assert.rejects(browser.client().admin.organization.get({}), {
            code: 'UNAUTHORIZED',
        });
    }

    async function enroll(browser: Browser) {
        const enabled = success(
            await browser.request('two-factor/enable', { password })
        );
        let uri: URL;
        try {
            uri = new URL(stringField(enabled.totpURI));
        } catch {
            assert.fail('Native TOTP enrollment must return a valid URL.');
        }
        const secret = uri.searchParams.get('secret');
        assert.ok(secret, 'Native enrollment must contain a TOTP secret.');
        return secret;
    }

    async function verifyTotp(browser: Browser, secret: string) {
        success(
            await browser.request('two-factor/verify-totp', {
                code: totp(secret),
            })
        );
    }

    await t.test(
        'native signup without membership creates an account-only session and retains account reads',
        async () => {
            const target = await account('no-membership');
            await assertAccountOnly(target.browser, target.id);
        }
    );

    await t.test(
        'fresh native sign-in ignores older inactive, removed and foreign memberships',
        async () => {
            const target = await account('eligible');
            const foreign = await account('foreign');
            const foreignOrg = await organization('foreign');
            const removedOrg = await organization('removed');
            const inactiveOrg = await organization('inactive', false);
            const activeOrg = await organization('eligible');
            await membership(foreign.id, foreignOrg, older);
            const removed = await membership(target.id, removedOrg, older);
            await prisma.member.delete({ where: { id: removed } });
            await membership(target.id, inactiveOrg, older);
            await membership(target.id, activeOrg, newer);

            const signedIn = await signIn(target.email);
            assert.equal((await readSession(signedIn)).userId, target.id);
            await assertSelection(signedIn, activeOrg);
            assert.equal(
                await prisma.member.count({
                    where: {
                        userId: target.id,
                        organizationId: { in: [removedOrg, foreignOrg] },
                    },
                }),
                0
            );
        }
    );

    await t.test(
        'native sign-in orders by membership creation rather than organization creation or insertion order',
        async () => {
            const target = await account('membership-order');
            const firstOrganization = await organization(
                'old-organization',
                true,
                older
            );
            const laterOrganization = await organization(
                'new-organization',
                true,
                newer
            );
            await membership(target.id, firstOrganization, newer);
            await membership(target.id, laterOrganization, older);
            await assertSelection(
                await signIn(target.email),
                laterOrganization
            );
        }
    );

    await t.test(
        'equal membership timestamps use a stable ID tie-breaker across fresh native sessions',
        async () => {
            const target = await account('id-tie');
            const firstOrganization = await organization('tie-z');
            const chosenOrganization = await organization('tie-a');
            await membership(
                target.id,
                firstOrganization,
                older,
                `${run}-tie-z`
            );
            await membership(
                target.id,
                chosenOrganization,
                older,
                `${run}-tie-a`
            );
            for (let attempt = 0; attempt < 2; attempt++) {
                await assertSelection(
                    await signIn(target.email),
                    chosenOrganization
                );
            }
        }
    );

    await t.test(
        'fresh native sign-in with only inactive memberships keeps a null selection without denying the account',
        async () => {
            const target = await account('all-inactive');
            const inactiveOrg = await organization('only-inactive', false);
            await membership(target.id, inactiveOrg);
            await assertAccountOnly(await signIn(target.email), target.id);
        }
    );

    await t.test(
        'real native TOTP enrollment rotation preserves a valid explicit selection while a fresh completed challenge uses the deterministic default',
        async () => {
            const target = await account('rotation');
            const defaultOrg = await organization('rotation-default');
            const selectedOrg = await organization('rotation-selected');
            await membership(target.id, defaultOrg, older);
            await membership(target.id, selectedOrg, newer);
            success(
                await target.browser.request('organization/set-active', {
                    organizationId: selectedOrg,
                })
            );
            const before = await readSession(target.browser);
            await assertSelection(target.browser, selectedOrg);
            const secret = await enroll(target.browser);
            await verifyTotp(target.browser, secret);
            const rotated = await readSession(target.browser);
            assert.ok(
                rotated.id !== before.id,
                'Native TOTP enrollment must rotate the session.'
            );
            assert.equal(
                await prisma.session.count({ where: { id: before.id } }),
                0
            );
            await assertSelection(target.browser, selectedOrg);

            const pending = localeBrowser();
            const challenge = success(
                await pending.request('sign-in/email', {
                    email: target.email,
                    password,
                })
            );
            assert.equal(challenge.twoFactorRedirect, true);
            assert.ok(
                (await pending.request('get-session')).body === null,
                'A pending native challenge must not expose an authenticated session.'
            );
            await assert.rejects(pending.client().admin.organization.get({}), {
                code: 'UNAUTHORIZED',
            });
            await verifyTotp(pending, secret);
            await assertSelection(pending, defaultOrg);
            assert.ok(
                (await readSession(pending)).id !== rotated.id,
                'Completed native sign-in must create a distinct session.'
            );
            // A separate fresh sign-in must not overwrite the older session's choice.
            await assertSelection(target.browser, selectedOrg);
        }
    );

    await t.test(
        'real native rotations replace stale inactive, removed and foreign selections with an eligible membership',
        async () => {
            const foreign = await account('rotation-foreign-owner');
            for (const kind of ['inactive', 'removed', 'foreign'] as const) {
                const target = await account(`stale-${kind}`);
                const staleOrg = await organization(
                    `stale-${kind}`,
                    kind !== 'inactive'
                );
                const activeOrg = await organization(`fallback-${kind}`);
                if (kind === 'foreign') {
                    await membership(foreign.id, staleOrg, older);
                } else {
                    const id = await membership(target.id, staleOrg, older);
                    if (kind === 'removed')
                        await prisma.member.delete({ where: { id } });
                }
                await membership(target.id, activeOrg, newer);
                const before = await readSession(target.browser);
                // Model a stale persisted selection on this owned test session.
                await prisma.session.update({
                    where: { id: before.id },
                    data: { activeOrganizationId: staleOrg },
                });
                await assert.rejects(
                    target.browser.client().admin.organization.get({}),
                    { code: kind === 'inactive' ? 'FORBIDDEN' : 'UNAUTHORIZED' }
                );
                const secret = await enroll(target.browser);
                await verifyTotp(target.browser, secret);
                assert.ok(
                    (await readSession(target.browser)).id !== before.id,
                    'The stale-selection case must exercise a real native rotation.'
                );
                await assertSelection(target.browser, activeOrg);
            }
        }
    );

    await t.test(
        'native rotation explicitly clears an inactive prior selection when no eligible membership remains',
        async () => {
            const target = await account('rotation-empty');
            const inactiveOrg = await organization(
                'rotation-no-eligible',
                false
            );
            await membership(target.id, inactiveOrg);
            const before = await readSession(target.browser);
            await prisma.session.update({
                where: { id: before.id },
                data: { activeOrganizationId: inactiveOrg },
            });
            const secret = await enroll(target.browser);
            await verifyTotp(target.browser, secret);
            assert.ok(
                (await readSession(target.browser)).id !== before.id,
                'Clearing the selection must occur during a real native rotation.'
            );
            await assertAccountOnly(target.browser, target.id);
        }
    );
}
