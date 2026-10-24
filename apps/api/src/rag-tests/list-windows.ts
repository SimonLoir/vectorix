import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { app } from '../app';
import { fixture as f } from './fixtures';
import { assertLegacyListCompatibility } from './list-window-compatibility';

/** Members and API-key lists accept optional server-side windows without changing legacy calls. */
export async function listWindowTests(t: TestContext) {
    await t.test(
        'legacy member and key lists stay complete above 1000 while every new window is bounded',
        assertLegacyListCompatibility
    );
    await t.test(
        'member lists keep the legacy full shape and add organization-scoped windows and search',
        async () => {
            const expected = await prisma.member.count({
                where: { organizationId: f.org },
            });
            assert.ok(expected >= 3);
            const legacy = await f.owner.client.admin.members.get({});
            assert.equal(legacy.members.length, expected);
            assert.equal(legacy.total, expected);
            assert.ok(
                legacy.members.every(
                    ({ organizationId }) => organizationId === f.org
                )
            );
            const first = await f.owner.client.admin.members.get({ limit: 1 });
            const second = await f.owner.client.admin.members.get({
                limit: 1,
                offset: 1,
            });
            assert.equal(first.members.length, 1);
            assert.equal(first.total, expected);
            assert.notEqual(first.members[0]!.id, second.members[0]!.id);
            assert.deepEqual(
                [first.members[0]!.id, second.members[0]!.id],
                legacy.members.slice(0, 2).map(({ id }) => id)
            );
            const reader = await prisma.member.findUniqueOrThrow({
                where: { id: f.readerMember },
                select: { user: { select: { email: true } } },
            });
            const search = await f.owner.client.admin.members.get({
                limit: 25,
                query: reader.user.email.toUpperCase(),
            });
            assert.deepEqual(
                search.members.map(({ id }) => id),
                [f.readerMember]
            );
            assert.equal(search.total, 1);
            // Another organization's member email never matches inside this organization.
            const foreign = await prisma.member.findUniqueOrThrow({
                where: { id: f.otherMember },
                select: { user: { select: { email: true } } },
            });
            assert.equal(
                (
                    await f.owner.client.admin.members.get({
                        limit: 25,
                        query: foreign.user.email,
                    })
                ).total,
                0
            );
            const rest = await app.request(
                'http://localhost:3001/api/v1/admin/members?limit=2&offset=0',
                { headers: f.owner.headers() }
            );
            assert.equal(rest.status, 200);
            const body = (await rest.json()) as {
                members: unknown[];
                total: number;
            };
            assert.equal(body.members.length, 2);
            assert.equal(body.total, expected);
            await assert.rejects(
                f.owner.client.admin.members.get({ limit: 101 }),
                { code: 'BAD_REQUEST' }
            );
        }
    );

    await t.test(
        'API-key lists page and search by name inside the organization only',
        async () => {
            const permissions = { ragCollection: ['read'] };
            const created = [];
            try {
                for (const name of ['Window alpha key', 'Window beta key'])
                    created.push(
                        await f.owner.client.admin.organization.apiKeys.create({
                            name,
                            permissions,
                        })
                    );
                const all =
                    await f.owner.client.admin.organization.apiKeys.list({});
                assert.ok(all.total >= 2);
                assert.equal(all.keys.length, all.total);
                const page =
                    await f.owner.client.admin.organization.apiKeys.list({
                        limit: 1,
                    });
                assert.equal(page.keys.length, 1);
                assert.equal(page.total, all.total);
                const beta =
                    await f.owner.client.admin.organization.apiKeys.list({
                        limit: 25,
                        query: 'window BETA',
                    });
                assert.deepEqual(
                    beta.keys.map(({ name }) => name),
                    ['Window beta key']
                );
                assert.equal(
                    (
                        await f.other.client.admin.organization.apiKeys.list({
                            limit: 25,
                            query: 'Window',
                        })
                    ).total,
                    0
                );
            } finally {
                await prisma.apikey.deleteMany({
                    where: {
                        configId: 'org',
                        referenceId: f.org,
                        id: { in: created.map(({ id }) => id) },
                    },
                });
            }
        }
    );
}
