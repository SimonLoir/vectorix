import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { ORPCError, os, type RouterClient } from '@orpc/server';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';
import { requirePermissions } from '@routers/utils/permissions';
import { createApiVersionRuntime } from './api-versioning/runtime-factory';
import type { ApiErrorLogger } from './api-versioning/error-observation';

const sentinel = 'ISSUE14_SOCKET_PRIVATE_SENTINEL';
const deniedMessage = 'You do not have the required permissions.';
const genericMessage = 'Internal server error';

/** The pure transport fixture imports no application registry, auth singleton, database or dotenv. */
void test(
    'real RPC/REST sockets sanitize failures and observe each procedure failure once',
    { timeout: 20_000 },
    async (t) => {
        const entries: unknown[][] = [];
        let failLogger = false;
        let loggerCalls = 0;
        const logger: ApiErrorLogger = {
            error(...args: unknown[]) {
                loggerCalls++;
                if (failLogger) throw new Error(sentinel);
                entries.push(args);
            },
        };
        const base = os.$context<{ logger: ApiErrorLogger }>();
        const input = z.object({}).strict();
        const output = z.object({ value: z.string() });
        let deniedMutations = 0;
        const router = {
            healthy: base
                .route({ method: 'POST', path: '/healthy' })
                .input(input)
                .output(output)
                .handler(() => ({ value: 'ok' })),
            denied: base
                .route({ method: 'POST', path: '/denied' })
                .input(input)
                .output(output)
                .handler(() => {
                    requirePermissions(
                        { permissions: {}, legacyApiKey: false },
                        { ragGroups: ['manage'] }
                    );
                    deniedMutations++;
                    return { value: 'must not run' };
                }),
            unexpected: base
                .route({ method: 'POST', path: '/unexpected' })
                .input(input)
                .output(output)
                .handler(() => {
                    throw Object.assign(
                        new Error(sentinel, { cause: new Error(sentinel) }),
                        {
                            metadata: {
                                token: sentinel,
                                providerResponse: sentinel,
                            },
                        }
                    );
                }),
            invalidOutput: base
                .route({ method: 'POST', path: '/invalid-output' })
                .input(input)
                .output(
                    z.object({
                        value: z
                            .string()
                            .refine(() => false, { message: sentinel }),
                    })
                )
                .handler(() => ({ value: sentinel })),
            controlled: base
                .route({ method: 'POST', path: '/controlled' })
                .input(input)
                .output(output)
                .handler(() => {
                    throw new ORPCError('SERVICE_UNAVAILABLE', {
                        message: 'Controlled service unavailable.',
                    });
                }),
        };
        const runtime = createApiVersionRuntime({ major: 1, router });
        const app = new Hono();
        for (const [prefix, handler] of [
            ['/rpc/v1', runtime.rpcHandler],
            ['/api/v1', runtime.openApiHandler],
        ] as const) {
            app.all(`${prefix}/*`, async (context) => {
                const result = await handler.handle(context.req.raw, {
                    prefix,
                    context: { logger },
                });
                return result.matched ? result.response : context.notFound();
            });
        }
        const sockets = new Set<Socket>();
        const server = serve({
            fetch: app.fetch,
            hostname: '127.0.0.1',
            port: 0,
        });
        server.on('connection', (socket: Socket) => {
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        try {
            if (!server.listening) await once(server, 'listening');
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            const origin = `http://127.0.0.1:${address.port}`;
            for (const transport of ['RPC', 'REST'] as const) {
                await t.test(
                    `${transport} controlled and unexpected failure boundaries`,
                    async () => {
                        entries.length = 0;
                        let capturedResponse: Response | undefined;
                        const client = createORPCClient<
                            RouterClient<typeof router>
                        >(
                            new RPCLink({
                                url: `${origin}/rpc/v1`,
                                fetch: async (request, init) => {
                                    const response = await fetch(request, {
                                        ...init,
                                        signal: AbortSignal.timeout(3000),
                                    });
                                    capturedResponse = response.clone();
                                    return response;
                                },
                            })
                        );
                        if (transport === 'RPC') {
                            assert.deepEqual(await client.healthy({}), {
                                value: 'ok',
                            });
                        } else {
                            const healthy = await fetch(
                                `${origin}/api/v1/healthy`,
                                {
                                    method: 'POST',
                                    headers: {
                                        'content-type': 'application/json',
                                    },
                                    body: '{}',
                                    signal: AbortSignal.timeout(3000),
                                }
                            );
                            assert.equal(healthy.status, 200);
                            assert.deepEqual(await healthy.json(), {
                                value: 'ok',
                            });
                        }
                        assert.equal(entries.length, 0);
                        const cases = [
                            {
                                name: 'denied',
                                rest: 'denied',
                                code: 'FORBIDDEN',
                                status: 403,
                                message: deniedMessage,
                                errorKind: null,
                                loggerFails: false,
                            },
                            {
                                name: 'unexpected',
                                rest: 'unexpected',
                                code: 'INTERNAL_SERVER_ERROR',
                                status: 500,
                                message: genericMessage,
                                errorKind: 'UNEXPECTED',
                                loggerFails: false,
                            },
                            {
                                name: 'invalidOutput',
                                rest: 'invalid-output',
                                code: 'INTERNAL_SERVER_ERROR',
                                status: 500,
                                message: genericMessage,
                                errorKind: 'OUTPUT_VALIDATION',
                                loggerFails: false,
                            },
                            {
                                name: 'controlled',
                                rest: 'controlled',
                                code: 'SERVICE_UNAVAILABLE',
                                status: 503,
                                message: 'Controlled service unavailable.',
                                errorKind: 'UNEXPECTED',
                                loggerFails: false,
                            },
                            {
                                name: 'unexpected',
                                rest: 'unexpected',
                                code: 'INTERNAL_SERVER_ERROR',
                                status: 500,
                                message: genericMessage,
                                errorKind: 'UNEXPECTED',
                                loggerFails: true,
                            },
                        ] as const;
                        for (const fixture of cases) {
                            entries.length = 0;
                            failLogger = fixture.loggerFails;
                            const previousLoggerCalls = loggerCalls;
                            let response: Response;
                            if (transport === 'RPC') {
                                capturedResponse = undefined;
                                await assert.rejects(client[fixture.name]({}), {
                                    code: fixture.code,
                                    message: fixture.message,
                                });
                                assert.ok(
                                    capturedResponse,
                                    'The real RPC fetch must capture a response.'
                                );
                                response = capturedResponse;
                            } else {
                                response = await fetch(
                                    `${origin}/api/v1/${fixture.rest}`,
                                    {
                                        method: 'POST',
                                        headers: {
                                            'content-type': 'application/json',
                                        },
                                        body: '{}',
                                        signal: AbortSignal.timeout(3000),
                                    }
                                );
                            }
                            assert.equal(response.status, fixture.status);
                            const text = await response.text();
                            assert.ok(
                                Buffer.byteLength(text) <= 2048,
                                'Public error envelopes must remain bounded.'
                            );
                            assert.ok(
                                !text.includes(sentinel),
                                'Private failure data must not reach HTTP.'
                            );
                            const body: unknown = JSON.parse(text);
                            const expected = {
                                defined: false,
                                code: fixture.code,
                                status: fixture.status,
                                message: fixture.message,
                            };
                            assert.deepEqual(
                                body,
                                transport === 'RPC'
                                    ? { json: expected }
                                    : expected
                            );
                            const fields =
                                fixture.errorKind === null ||
                                fixture.loggerFails
                                    ? []
                                    : [
                                          [
                                              {
                                                  errorKind: fixture.errorKind,
                                                  transport,
                                                  major: 1,
                                                  ...(fixture.errorKind ===
                                                  'OUTPUT_VALIDATION'
                                                      ? { issueCount: 1 }
                                                      : {}),
                                              },
                                              'API request failed',
                                          ],
                                      ];
                            assert.deepEqual(entries, fields);
                            assert.equal(
                                loggerCalls,
                                previousLoggerCalls +
                                    (fixture.errorKind === null ? 0 : 1),
                                'A failed logger must not retry or replace the HTTP response.'
                            );
                            assert.ok(
                                !JSON.stringify(entries).includes(sentinel),
                                'Logger summaries must not retain private failure data.'
                            );
                        }
                        failLogger = false;
                    }
                );
            }
            assert.equal(deniedMutations, 0);
        } finally {
            for (const socket of sockets) socket.destroy();
            if ('closeAllConnections' in server) server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        }
    }
);
