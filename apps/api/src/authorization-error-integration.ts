import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { RouterClient } from '@orpc/server';
import type { VectorixApiV1Client } from '@repo/api';
import { VECTORIX_API_V1 } from '@repo/api/versioning';
import { prisma } from '@repo/db';
import { authorized } from '@routers/utils/authorized';
import { Hono } from 'hono';
import { z } from 'zod';
import { app } from './app';
import { logger } from './lib/logger';
import { createApiVersionRuntime } from './api-versioning/runtime-factory';
import { object, stringField } from './user-locale-tests/http';

type Browser = {
    post(path: string, body: unknown): Promise<unknown>;
    headers(extra?: Record<string, string>): Record<string, string>;
    client(extra?: Record<string, string>): VectorixApiV1Client;
};
type Fixture = {
    owner: Browser;
    organizationId: string;
    createBrowser(): Browser;
    registerUser(id: string): void;
};
const denial = {
    defined: false,
    code: 'FORBIDDEN',
    status: 403,
    message: 'You do not have the required permissions.',
};

/** Capture a separate wire envelope while the normal SDK performs actual RPC serialization. */
function capturedRpc(
    request: (input: Request) => Promise<Response>,
    headers: Record<string, string>
) {
    let response: Response | undefined;
    const link = new RPCLink({
        url: 'http://localhost:3001/rpc/v1',
        headers,
        fetch: async (input) => {
            const result = await request(input);
            response = result.clone();
            return result;
        },
    });
    return {
        link,
        response() {
            assert.ok(
                response,
                'The actual RPC HTTP request must have completed.'
            );
            const captured = response;
            response = undefined;
            return captured;
        },
    };
}

async function assertDenied(
    response: Response,
    rpc: boolean,
    versioned = true
) {
    assert.equal(response.status, 403);
    if (versioned) {
        assert.equal(response.headers.get('Vectorix-API-Version'), '1');
        assert.equal(
            response.headers.get('Vectorix-API-Revision'),
            String(VECTORIX_API_V1.revision)
        );
    }
    const text = await response.text();
    assert.ok(
        Buffer.byteLength(text) <= 1024,
        'Permission denial envelopes must remain bounded.'
    );
    const value: unknown = JSON.parse(text);
    assert.deepEqual(value, rpc ? { json: denial } : denial);
}

/** Real cookie sessions and production permission middleware operate only on registered _test fixtures. */
export async function authorizationErrorIntegrationTests(
    t: TestContext,
    f: Fixture
) {
    assert.ok(
        new URL(
            process.env.DATABASE_URL ?? 'postgresql://localhost/'
        ).pathname.endsWith('_test'),
        'Authorization error integration requires the isolated test database.'
    );
    const run = randomUUID();
    const limited = f.createBrowser();
    const signup = object(
        await limited.post('sign-up/email', {
            name: 'Authorization error limited member',
            email: `authorization-error-${run}@example.test`,
            password: 'Authorization-error-test-password-928!',
        })
    );
    const userId = stringField(object(signup.user).id);
    f.registerUser(userId);
    await prisma.member.create({
        data: {
            id: randomUUID(),
            userId,
            organizationId: f.organizationId,
            role: 'member',
            createdAt: new Date(),
        },
    });
    await limited.post('organization/set-active', {
        organizationId: f.organizationId,
    });
    assert.equal((await limited.client().admin.members.me({})).userId, userId);
    assert.equal(
        (
            await prisma.user.findUniqueOrThrow({
                where: { id: userId },
                select: { isSuperAdmin: true },
            })
        ).isSuperAdmin,
        false
    );
    const controlGroup = await f.owner
        .client()
        .admin.rag.groups.create({ name: `Authorization control ${run}` });

    async function snapshot() {
        const [groups, audits, members, sessions] = await Promise.all([
            prisma.organizationGroup.findMany({
                where: { organizationId: f.organizationId },
                select: { id: true, name: true, updatedAt: true },
                orderBy: { id: 'asc' },
                take: 1001,
            }),
            prisma.ragAuditLog.findMany({
                where: { organizationId: f.organizationId },
                select: { id: true, action: true, targetId: true },
                orderBy: { id: 'asc' },
                take: 2001,
            }),
            prisma.member.findMany({
                where: { organizationId: f.organizationId, userId },
                select: {
                    id: true,
                    organizationId: true,
                    userId: true,
                    role: true,
                },
                orderBy: { id: 'asc' },
            }),
            prisma.session.findMany({
                where: { userId },
                select: { id: true, userId: true, activeOrganizationId: true },
                orderBy: { id: 'asc' },
            }),
        ]);
        assert.ok(
            groups.length <= 1000 && audits.length <= 2000,
            'The owned fixture snapshot must remain bounded.'
        );
        return { groups, audits, members, sessions };
    }

    async function unchanged(before: Awaited<ReturnType<typeof snapshot>>) {
        assert.ok(
            isDeepStrictEqual(await snapshot(), before),
            'Denied operations must preserve groups, audit rows, membership and session context.'
        );
    }

    try {
        await t.test(
            'actual RPC authorization denies group mutations with fixed English and no database or audit effects',
            async () => {
                const captured = capturedRpc(
                    (request) => Promise.resolve(app.request(request)),
                    limited.headers()
                );
                const client = createORPCClient<VectorixApiV1Client>(
                    captured.link
                );
                for (const operation of [
                    () =>
                        client.admin.rag.groups.create({
                            name: `Denied RPC ${run}`,
                        }),
                    () =>
                        client.admin.rag.groups.rename({
                            id: controlGroup.id,
                            name: `Denied rename ${run}`,
                        }),
                ]) {
                    const before = await snapshot();
                    await assert.rejects(operation(), {
                        code: denial.code,
                        status: denial.status,
                        message: denial.message,
                    });
                    await assertDenied(captured.response(), true);
                    await unchanged(before);
                }
            }
        );

        await t.test(
            'actual REST authorization denies create and direct-ID delete with unchanged database and audit state',
            async () => {
                for (const [method, path, body] of [
                    [
                        'POST',
                        '/api/v1/admin/rag/groups',
                        { name: `Denied REST ${run}` },
                    ],
                    [
                        'DELETE',
                        `/api/v1/admin/rag/groups/${controlGroup.id}`,
                        undefined,
                    ],
                ] as const) {
                    const before = await snapshot();
                    const response = await app.request(path, {
                        method,
                        headers: limited.headers(
                            body ? { 'content-type': 'application/json' } : {}
                        ),
                        ...(body ? { body: JSON.stringify(body) } : {}),
                    });
                    await assertDenied(response, false);
                    await unchanged(before);
                }
            }
        );

        await t.test(
            'the production authenticated guard rejects an unclassified test-only operation on both transports',
            async () => {
                let handlerCalls = 0;
                const router = {
                    issue14: {
                        unknownPrivate: authorized
                            .route({
                                method: 'POST',
                                path: '/unclassified-operation',
                            })
                            .input(z.object({}).strict())
                            .output(z.object({ success: z.literal(true) }))
                            .handler(() => {
                                handlerCalls++;
                                return { success: true as const };
                            }),
                    },
                };
                const runtime = createApiVersionRuntime({ major: 1, router });
                const guardedApp = new Hono();
                for (const [prefix, handler] of [
                    ['/rpc/v1', runtime.rpcHandler],
                    ['/api/v1', runtime.openApiHandler],
                ] as const) {
                    guardedApp.all(`${prefix}/*`, async (context) => {
                        const result = await handler.handle(context.req.raw, {
                            prefix,
                            context: {
                                headers: context.req.raw.headers,
                                db: prisma,
                                logger,
                            },
                        });
                        return result.matched
                            ? result.response
                            : context.notFound();
                    });
                }
                const captured = capturedRpc(
                    (request) => Promise.resolve(guardedApp.request(request)),
                    limited.headers()
                );
                const client = createORPCClient<RouterClient<typeof router>>(
                    captured.link
                );
                const before = await snapshot();
                await assert.rejects(client.issue14.unknownPrivate({}), {
                    code: denial.code,
                    status: 403,
                    message: denial.message,
                });
                await assertDenied(captured.response(), true, false);
                await unchanged(before);
                const response = await guardedApp.request(
                    '/api/v1/unclassified-operation',
                    {
                        method: 'POST',
                        headers: limited.headers({
                            'content-type': 'application/json',
                        }),
                        body: '{}',
                    }
                );
                await assertDenied(response, false, false);
                await unchanged(before);
                assert.equal(handlerCalls, 0);
            }
        );
    } finally {
        await f.owner.client().admin.rag.groups.delete({ id: controlGroup.id });
    }
}
