import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { authorized } from '@routers/utils/authorized';
import { z } from 'zod';
import { app } from './app';
import { logger } from './lib/logger';

type Browser = {
    post(path: string, body: unknown): Promise<unknown>;
    headers(extra?: Record<string, string>): Record<string, string>;
    client(extra?: Record<string, string>): VectorixApiV1Client;
};

type Fixture = {
    owner: Browser;
    foreign: Browser;
    createBrowser(): Browser;
    organizationId: string;
    foreignOrganizationId: string;
    registerUser(id: string): void;
};

function keyClient(key: string, extra: Record<string, string> = {}) {
    return createORPCClient<VectorixApiV1Client>(
        new RPCLink({
            url: 'http://localhost:3001/rpc/v1',
            headers: { 'x-api-key': key, ...extra },
            fetch: (request) => Promise.resolve(app.request(request)),
        })
    );
}

/** Exercises delegated admission through HTTP against current database membership and native roles. */
export async function apiKeyIssuerRevocationTests(t: TestContext, f: Fixture) {
    const id = randomUUID().slice(0, 8);
    const issuer = f.createBrowser();
    const email = `key-issuer-${id}@example.test`;
    await issuer.post('sign-up/email', {
        name: 'Delegating issuer',
        email,
        password: 'Local-test-password-928!',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    f.registerUser(user.id);
    const settingsRole = `key-settings-${id}`;
    const libraryRole = `key-library-${id}`;
    const restrictedRole = `key-restricted-${id}`;
    const settingsPermissions = {
        settings: ['read'],
        apiKey: ['create', 'update'],
    };
    const delegatedPermissions = {
        settings: ['read'],
        ragLibrary: ['read'],
    };
    for (const [role, permission] of [
        [settingsRole, settingsPermissions],
        [libraryRole, { ragLibrary: ['read'] }],
        [restrictedRole, { dashboard: ['read'] }],
    ] as const) {
        await f.owner.post('organization/create-role', {
            organizationId: f.organizationId,
            role,
            permission,
        });
    }
    // Better Auth's add-member endpoint is server-only; initial membership is fixture data.
    const originalMemberId = randomUUID();
    await prisma.member.create({
        data: {
            id: originalMemberId,
            organizationId: f.organizationId,
            userId: user.id,
            role: `${settingsRole},${libraryRole}`,
            createdAt: new Date(),
        },
    });
    await issuer.post('organization/set-active', {
        organizationId: f.organizationId,
    });
    const issue = (name: string, permissions = delegatedPermissions) =>
        issuer.client().admin.organization.apiKeys.create({
            name: `${name} ${id}`,
            permissions,
        });
    const key = await issue('Current issuer');
    const client = keyClient(key.key);
    const setRoles = (role: string[]) =>
        f.owner.post('organization/update-member-role', {
            organizationId: f.organizationId,
            memberId: originalMemberId,
            role,
        });
    const updateSettingsRole = (permission: Record<string, string[]>) =>
        f.owner.post('organization/update-role', {
            organizationId: f.organizationId,
            roleName: settingsRole,
            data: { permission },
        });
    const assertSettingsRead = async () =>
        assert.equal(
            (await client.admin.organization.get({})).id,
            f.organizationId
        );

    await t.test(
        'bound API keys retain a key identity and combine current issuer roles',
        async () => {
            await assertSettingsRead();
            assert.equal((await client.admin.rag.documents.list({})).total, 0);
            const stored = await prisma.apikey.findUniqueOrThrow({
                where: { id: key.id },
            });
            assert.notEqual(stored.key, key.key);
            assert.equal(stored.vectorixLegacyFullAccess, false);
            assert.equal(
                (
                    await prisma.apiKeyPrincipal.findUniqueOrThrow({
                        where: { keyId: key.id },
                    })
                ).memberId,
                originalMemberId
            );

            // A classified test-only procedure observes the real middleware context over HTTP.
            // Its sibling proves an unclassified private operation cannot reach its handler.
            let unknownCalls = 0;
            const routes = {
                admin: {
                    organization: {
                        get: authorized
                            .input(z.object({}))
                            .handler(({ context }) => ({
                                keyId: context.key?.id,
                                userIsNull: context.user === null,
                                sessionIsNull: context.session === null,
                                legacyApiKey: context.legacyApiKey,
                            })),
                    },
                },
                unclassifiedPrivateOperation: authorized
                    .input(z.object({}))
                    .handler(() => {
                        unknownCalls++;
                        return { reached: true };
                    }),
            };
            const handler = new RPCHandler(routes);
            const observation = createORPCClient<RouterClient<typeof routes>>(
                new RPCLink({
                    url: 'http://localhost:3001/issuer-regression',
                    headers: { 'x-api-key': key.key },
                    fetch: async (request) => {
                        const result = await handler.handle(request, {
                            prefix: '/issuer-regression',
                            context: {
                                headers: request.headers,
                                db: prisma,
                                logger,
                            },
                        });
                        return (
                            result.response ??
                            new Response(null, { status: 404 })
                        );
                    },
                })
            );
            assert.deepEqual(await observation.admin.organization.get({}), {
                keyId: key.id,
                userIsNull: true,
                sessionIsNull: true,
                legacyApiKey: false,
            });
            await assert.rejects(observation.unclassifiedPrivateOperation({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            assert.equal(unknownCalls, 0);
        }
    );

    await t.test(
        'current role edits revoke and restore delegated actions without reissuing keys',
        async () => {
            await updateSettingsRole({ apiKey: ['create', 'update'] });
            await assert.rejects(client.admin.organization.get({}), {
                code: 'FORBIDDEN',
            });
            // An independent role still contributes its own actions.
            assert.equal((await client.admin.rag.documents.list({})).total, 0);
            await updateSettingsRole(settingsPermissions);
            await assertSettingsRead();

            await updateSettingsRole({ settings: ['read'] });
            await assertSettingsRead();
            await assert.rejects(issue('No issuance permission'), {
                code: 'FORBIDDEN',
            });
            await updateSettingsRole(settingsPermissions);

            // Built-in member has settings.read; a truly restricted custom role is needed here.
            await setRoles([restrictedRole]);
            await assert.rejects(client.admin.organization.get({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(client.admin.rag.documents.list({}), {
                code: 'FORBIDDEN',
            });
            await setRoles([restrictedRole, settingsRole]);
            await assertSettingsRead();
            await assert.rejects(client.admin.rag.documents.list({}), {
                code: 'FORBIDDEN',
            });
            await setRoles([settingsRole, libraryRole]);
            await assertSettingsRead();
            assert.equal((await client.admin.rag.documents.list({})).total, 0);
        }
    );

    await t.test(
        'issuer promotion never expands stored key scope or creates a user session',
        async () => {
            const narrow = await issuer
                .client()
                .admin.organization.apiKeys.create({
                    name: `Narrow scope ${id}`,
                    permissions: { settings: ['read'] },
                });
            const api = keyClient(narrow.key);
            const libraryOnly = await issuer
                .client()
                .admin.organization.apiKeys.create({
                    name: `Library-only scope ${id}`,
                    permissions: { ragLibrary: ['read'] },
                });
            const libraryApi = keyClient(libraryOnly.key);
            // The generic route has no RAG guard that could mask a middleware scope regression.
            assert.equal(
                (await libraryApi.admin.rag.documents.list({})).total,
                0
            );
            await assert.rejects(libraryApi.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            await assert.rejects(api.admin.rag.documents.list({}), {
                code: 'FORBIDDEN',
            });
            await setRoles(['admin']);
            assert.equal(
                (await api.admin.organization.get({})).id,
                f.organizationId
            );
            await assert.rejects(api.admin.rag.documents.list({}), {
                code: 'FORBIDDEN',
            });
            assert.equal(
                (await libraryApi.admin.rag.documents.list({})).total,
                0
            );
            await assert.rejects(libraryApi.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            for (const call of [
                () => api.admin.members.me({}),
                () => api.admin.organization.access({}),
                () => api.admin.notifications.list({}),
                () => api.superadmin.me({}),
                () =>
                    api.admin.organization.apiKeys.create({
                        name: 'Cannot delegate',
                        permissions: { settings: ['read'] },
                    }),
            ])
                await assert.rejects(call(), { code: 'FORBIDDEN' });
            await setRoles([settingsRole, libraryRole]);
        }
    );

    await t.test(
        'tenant pinning and exact issuer binding reject foreign, unbound and legacy keys',
        async () => {
            await assert.rejects(
                keyClient(key.key, {
                    'Vectorix-Expected-Organization-Id':
                        f.foreignOrganizationId,
                }).admin.organization.get({}),
                { code: 'CONFLICT', status: 409 }
            );
            assert.equal(
                (
                    await keyClient(key.key, {
                        'Vectorix-Expected-Organization-Id': f.organizationId,
                    }).admin.organization.get({})
                ).id,
                f.organizationId
            );
            const foreignMember = await f.foreign.client().admin.members.me({});
            await prisma.apiKeyPrincipal.update({
                where: { keyId: key.id },
                data: {
                    organizationId: f.foreignOrganizationId,
                    memberId: foreignMember.id,
                },
            });
            await assert.rejects(client.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            await prisma.apiKeyPrincipal.update({
                where: { keyId: key.id },
                data: {
                    organizationId: f.organizationId,
                    memberId: originalMemberId,
                },
            });
            await assertSettingsRead();

            const unbound = await issue('Historical unbound');
            await prisma.apiKeyPrincipal.delete({
                where: { keyId: unbound.id },
            });
            const unboundApi = keyClient(unbound.key);
            await assert.rejects(unboundApi.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            assert.ok(
                await prisma.apikey.findUnique({ where: { id: unbound.id } })
            );
            assert.equal(
                await prisma.apiKeyPrincipal.findUnique({
                    where: { keyId: unbound.id },
                }),
                null
            );
            await prisma.apikey.update({
                where: { id: unbound.id },
                data: { vectorixLegacyFullAccess: true },
            });
            await assert.rejects(unboundApi.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            const legacy = await issue('Historical bound legacy');
            await prisma.apikey.update({
                where: { id: legacy.id },
                data: { vectorixLegacyFullAccess: true },
            });
            await assert.rejects(
                keyClient(legacy.key).admin.organization.get({}),
                { code: 'FORBIDDEN', status: 403 }
            );
        }
    );

    await t.test(
        'malformed stored permissions and disabled credentials fail closed without disclosure',
        async () => {
            const invalid = await issue('Stored scope validation');
            const invalidApi = keyClient(invalid.key);
            for (const permissions of [
                'not-json-sensitive-marker',
                JSON.stringify({ settings: 'read' }),
                JSON.stringify({ settings: ['unrecognized'] }),
                JSON.stringify({ member: ['read'] }),
                '{}',
                null,
            ]) {
                await prisma.apikey.update({
                    where: { id: invalid.id },
                    data: { permissions },
                });
                await assert.rejects(
                    invalidApi.admin.organization.get({}),
                    (error: unknown) => {
                        assert.ok(
                            error &&
                                typeof error === 'object' &&
                                'code' in error &&
                                'status' in error
                        );
                        assert.equal(error.code, 'FORBIDDEN');
                        assert.equal(error.status, 403);
                        assert.ok(
                            !JSON.stringify(error).includes('sensitive-marker')
                        );
                        assert.ok(!JSON.stringify(error).includes(invalid.key));
                        return true;
                    }
                );
            }
            await prisma.apikey.update({
                where: { id: invalid.id },
                data: {
                    permissions: JSON.stringify(delegatedPermissions),
                    enabled: false,
                },
            });
            await assert.rejects(invalidApi.admin.organization.get({}), {
                code: 'INVALID_API_KEY',
                status: 401,
            });
            await assert.rejects(
                keyClient('invalid-secret').admin.organization.get({}),
                { code: 'INVALID_API_KEY', status: 401 }
            );
        }
    );

    await t.test(
        'native endpoints and scoped updates cannot bypass issuance restrictions',
        async () => {
            const before = await prisma.apikey.count({
                where: { referenceId: f.organizationId },
            });
            const stored = await prisma.apikey.findUniqueOrThrow({
                where: { id: key.id },
            });
            const owner = await f.owner.client().admin.members.me({});
            for (const [path, body, headers] of [
                [
                    'api-key/create',
                    {
                        configId: 'org',
                        organizationId: f.organizationId,
                        userId: owner.userId,
                        name: 'Forged issuer',
                        permissions: { settings: ['read'] },
                    },
                    issuer.headers(),
                ],
                [
                    'api-key/create',
                    {
                        configId: 'org',
                        organizationId: f.organizationId,
                        userId: user.id,
                        name: 'Key delegated issuance',
                        permissions: { settings: ['read'] },
                    },
                    { 'x-api-key': key.key },
                ],
                [
                    'api-key/update',
                    {
                        configId: 'org',
                        keyId: key.id,
                        permissions: { settings: ['read', 'update'] },
                    },
                    issuer.headers(),
                ],
                [
                    'api-key/update',
                    {
                        configId: 'org',
                        keyId: key.id,
                        vectorixLegacyFullAccess: true,
                    },
                    issuer.headers(),
                ],
            ] as const) {
                const response = await app.request(
                    `http://localhost:3001/api/auth/${path}`,
                    {
                        method: 'POST',
                        headers: {
                            ...headers,
                            origin: 'http://localhost:3000',
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify(body),
                    }
                );
                assert.equal(response.status, 403, `${path} bypass must fail`);
            }
            await assert.rejects(
                issuer.client().admin.organization.apiKeys.create({
                    name: 'Cannot grant absent permission',
                    permissions: { settings: ['update'] },
                }),
                { code: 'FORBIDDEN' }
            );
            await assert.rejects(
                issuer.client().admin.organization.apiKeys.updatePermissions({
                    keyId: key.id,
                    permissions: { settings: ['read', 'update'] },
                }),
                { code: 'FORBIDDEN' }
            );
            await assert.rejects(
                issuer.client().admin.organization.apiKeys.create({
                    name: 'Reserved administration',
                    permissions: { member: ['read'] },
                }),
                { code: 'BAD_REQUEST' }
            );
            assert.equal(
                await prisma.apikey.count({
                    where: { referenceId: f.organizationId },
                }),
                before
            );
            const after = await prisma.apikey.findUniqueOrThrow({
                where: { id: key.id },
            });
            assert.equal(after.permissions, stored.permissions);
            assert.equal(after.vectorixLegacyFullAccess, false);
            assert.equal(
                (
                    await prisma.apiKeyPrincipal.findUniqueOrThrow({
                        where: { keyId: key.id },
                    })
                ).memberId,
                originalMemberId
            );
            await assertSettingsRead();
        }
    );

    await t.test(
        'removal revokes surviving keys and rejoining never resurrects the original issuer binding',
        async () => {
            await f.owner.post('organization/remove-member', {
                organizationId: f.organizationId,
                memberIdOrEmail: originalMemberId,
            });
            assert.ok(
                await prisma.apikey.findUnique({ where: { id: key.id } })
            );
            assert.equal(
                await prisma.apiKeyPrincipal.findUnique({
                    where: { keyId: key.id },
                }),
                null
            );
            await assert.rejects(client.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            const newMemberId = randomUUID();
            await prisma.member.create({
                data: {
                    id: newMemberId,
                    organizationId: f.organizationId,
                    userId: user.id,
                    role: `${settingsRole},${libraryRole}`,
                    createdAt: new Date(),
                },
            });
            await issuer.post('organization/set-active', {
                organizationId: f.organizationId,
            });
            await assert.rejects(client.admin.organization.get({}), {
                code: 'FORBIDDEN',
                status: 403,
            });
            assert.equal(
                await prisma.apiKeyPrincipal.findUnique({
                    where: { keyId: key.id },
                }),
                null
            );
            const reissued = await issue('Reissued after rejoin');
            assert.equal(
                (await keyClient(reissued.key).admin.organization.get({})).id,
                f.organizationId
            );
            assert.equal(
                (
                    await prisma.apiKeyPrincipal.findUniqueOrThrow({
                        where: { keyId: reissued.id },
                    })
                ).memberId,
                newMemberId
            );
            assert.notEqual(newMemberId, originalMemberId);
        }
    );
}
