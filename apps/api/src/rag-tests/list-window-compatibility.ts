import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '@repo/db';
import { app } from '../app';
import { fixture as f } from './fixtures';

/**
 * Create only isolated catalog metadata, not 1005 costly accounts or usable keys.
 * The importing fixture enforces the _test database boundary. Disabled synthetic
 * keys have no native credential and never authorize any request. Tied creation
 * dates make the secondary ID order observable in both real handlers.
 */
export async function assertLegacyListCompatibility() {
    const prefix = `list-window-${randomUUID()}`;
    const names = Array.from(
        { length: 1005 },
        (_, index) => `${prefix}-${String(index).padStart(4, '0')}`
    );
    const userIds = names.map((name) => `${name}-user`);
    const memberIds = names.map((name) => `${name}-member`);
    const keyIds = names.map((name) => `${name}-key`);
    const createdAt = new Date();
    try {
        await prisma.$transaction([
            prisma.user.createMany({
                data: names.map((name, index) => ({
                    id: userIds[index]!,
                    name,
                    email: `${name}@example.test`,
                })),
            }),
            prisma.member.createMany({
                data: memberIds.map((id, index) => ({
                    id,
                    organizationId: f.org,
                    userId: userIds[index]!,
                    role: 'member',
                    createdAt,
                })),
            }),
            prisma.apikey.createMany({
                data: keyIds.map((id, index) => ({
                    id,
                    name: names[index]!,
                    configId: 'org',
                    referenceId: f.org,
                    key: `disabled-synthetic-${id}`,
                    enabled: false,
                    permissions: '{}',
                    createdAt,
                    updatedAt: createdAt,
                })),
            }),
        ]);
        const expectedMembers = await prisma.member.findMany({
            where: { organizationId: f.org },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
        });
        const expectedKeys = await prisma.apikey.findMany({
            where: { configId: 'org', referenceId: f.org },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            select: { id: true },
        });
        assert.ok(expectedMembers.length > 1000);
        assert.ok(expectedKeys.length > 1000);
        const members = await f.owner.client.admin.members.get({});
        const keys = await f.owner.client.admin.organization.apiKeys.list({});
        assert.deepEqual(
            members.members.map(({ id }) => id),
            expectedMembers.map(({ id }) => id)
        );
        assert.deepEqual(
            keys.keys.map(({ id }) => id),
            expectedKeys.map(({ id }) => id)
        );
        assert.equal(members.total, expectedMembers.length);
        assert.equal(keys.total, expectedKeys.length);

        // Empty REST queries also exercise native contract defaults and output validation.
        for (const [path, field, expected] of [
            ['members', 'members', expectedMembers],
            ['organization/api-keys', 'keys', expectedKeys],
        ] as const) {
            const response = await app.request(
                `http://localhost:3001/api/v1/admin/${path}`,
                {
                    headers: f.owner.headers(),
                }
            );
            assert.equal(response.status, 200);
            const body: unknown = await response.json();
            assert.ok(
                body &&
                    typeof body === 'object' &&
                    field in body &&
                    'total' in body
            );
            let rows: unknown;
            if (field === 'members') {
                assert.ok('members' in body);
                rows = body.members;
            } else {
                assert.ok('keys' in body);
                rows = body.keys;
            }
            assert.ok(Array.isArray(rows));
            assert.equal(rows.length, expected.length);
            assert.equal(body.total, expected.length);
        }

        for (const input of [{ query: '' }, { query: prefix }, { offset: 1 }]) {
            const memberPage = await f.owner.client.admin.members.get(input);
            const keyPage =
                await f.owner.client.admin.organization.apiKeys.list(input);
            assert.equal(memberPage.members.length, 25);
            assert.equal(keyPage.keys.length, 25);
            assert.equal(
                memberPage.total,
                input.query ? 1005 : expectedMembers.length
            );
            assert.equal(
                keyPage.total,
                input.query ? 1005 : expectedKeys.length
            );
            if ('offset' in input) {
                assert.deepEqual(
                    memberPage.members.map(({ id }) => id),
                    expectedMembers.slice(1, 26).map(({ id }) => id)
                );
                assert.deepEqual(
                    keyPage.keys.map(({ id }) => id),
                    expectedKeys.slice(1, 26).map(({ id }) => id)
                );
            }
        }
        const memberMaximum = await f.owner.client.admin.members.get({
            limit: 100,
        });
        const keyMaximum = await f.owner.client.admin.organization.apiKeys.list(
            { limit: 100 }
        );
        assert.equal(memberMaximum.members.length, 100);
        assert.equal(keyMaximum.keys.length, 100);
        for (const input of [
            { limit: 101 },
            { offset: -1 },
            { offset: 100_001 },
            { query: 'x'.repeat(201) },
        ]) {
            await assert.rejects(f.owner.client.admin.members.get(input), {
                code: 'BAD_REQUEST',
            });
            await assert.rejects(
                f.owner.client.admin.organization.apiKeys.list(input),
                { code: 'BAD_REQUEST' }
            );
        }
        assert.equal(
            (await f.other.client.admin.members.get({ query: prefix })).total,
            0
        );
        assert.equal(
            (
                await f.other.client.admin.organization.apiKeys.list({
                    query: prefix,
                })
            ).total,
            0
        );
    } finally {
        // Explicit organization/IDs keep cleanup bounded even when an assertion fails.
        await prisma.$transaction([
            prisma.apikey.deleteMany({
                where: {
                    configId: 'org',
                    referenceId: f.org,
                    id: { in: keyIds },
                },
            }),
            prisma.member.deleteMany({
                where: { organizationId: f.org, id: { in: memberIds } },
            }),
            prisma.user.deleteMany({ where: { id: { in: userIds } } }),
        ]);
    }
}
