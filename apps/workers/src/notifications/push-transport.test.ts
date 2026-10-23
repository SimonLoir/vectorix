import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Agent, createServer, request, type RequestOptions } from 'node:https';
import type { Socket } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { Stream } from 'node:stream';
import test from 'node:test';
import webPush from 'web-push';
import {
    admitPushEndpoint,
    createPushEndpointPolicy,
} from '@routers/utils/push-endpoint-policy';
import {
    MAX_PUSH_HEADER_BYTES,
    MAX_PUSH_RESPONSE_BYTES,
    PUSH_DNS_TIMEOUT_MS,
    PUSH_TOTAL_TIMEOUT_MS,
    PushTransportError,
    sendNativePush,
    type PushHttpResponse,
    type PushRequestFactory,
} from './push-transport';

/** Native HTTP objects are Node streams; keep their error/once/data event contract in controlled tests. */
class ControlledRequest extends Stream {
    destroyed = false;
    body: Uint8Array | undefined;
    onEnd: (() => void) | undefined;
    end(body?: Uint8Array) {
        this.body = body;
        this.onEnd?.();
        return this;
    }
    destroy() {
        this.destroyed = true;
        return this;
    }
}
class ControlledResponse extends Stream implements PushHttpResponse {
    destroyed = false;
    constructor(
        public statusCode = 201,
        public headers: IncomingHttpHeaders = {}
    ) {
        super();
    }
    destroy() {
        this.destroyed = true;
        return this;
    }
}

function fixture() {
    const clientKey = createECDH('prime256v1');
    const subscription = {
        endpoint: 'https://push.example.test/a/../opaque%2Ftoken?x=%2f&x=1',
        keys: {
            p256dh: clientKey.generateKeys().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
        },
    };
    const admitted = admitPushEndpoint(
        subscription.endpoint,
        createPushEndpointPolicy('https://push.example.test')
    );
    assert.ok(admitted);
    return {
        subscription,
        admitted,
        payload: 'Controlled encrypted notification',
        options: {
            TTL: 3600,
            urgency: 'normal' as const,
            vapidDetails: {
                subject: 'mailto:test@example.test',
                ...webPush.generateVAPIDKeys(),
            },
        },
    };
}

function controlledResponse(
    status = 201,
    chunks: Buffer[] = [Buffer.from('accepted')],
    headers: IncomingHttpHeaders = {}
) {
    const outgoing = new ControlledRequest(),
        incoming = new ControlledResponse(status, headers);
    let captured: RequestOptions | undefined;
    const factory: PushRequestFactory = (options, callback) => {
        captured = options;
        outgoing.onEnd = () =>
            queueMicrotask(() => {
                callback(incoming);
                for (const chunk of chunks)
                    if (!incoming.destroyed) incoming.emit('data', chunk);
                if (!incoming.destroyed) incoming.emit('end');
            });
        return outgoing;
    };
    return { outgoing, incoming, factory, captured: () => captured };
}

void test('controlled native-encryption transport preserves opaque destination and strict HTTPS options', async () => {
    const f = fixture(),
        fake = controlledResponse();
    const result = await sendNativePush(
        f.subscription,
        f.payload,
        f.options,
        f.admitted,
        { request: fake.factory }
    );
    assert.deepEqual(result, {
        statusCode: 201,
        body: 'accepted',
        headers: {},
    });
    const sent = fake.captured();
    assert.ok(sent);
    assert.equal(sent.hostname, 'push.example.test');
    assert.equal(sent.port, 443);
    assert.equal(sent.path, '/a/../opaque%2Ftoken?x=%2f&x=1');
    assert.equal(sent.method, 'POST');
    assert.equal(sent.servername, 'push.example.test');
    assert.equal(sent.rejectUnauthorized, true);
    assert.equal(sent.maxHeaderSize, MAX_PUSH_HEADER_BYTES);
    assert.equal(sent.ca, undefined);
    assert.equal(sent.checkServerIdentity, undefined);
    assert.ok(sent.agent instanceof Agent);
    assert.equal(sent.agent.options.keepAlive, false);
    assert.deepEqual(sent.agent.options.proxyEnv, {});
    assert.equal(sent.agent.maxSockets, 1);
    assert.equal(sent.agent.maxTotalSockets, 1);
    assert.ok(
        fake.outgoing.body &&
            Buffer.from(fake.outgoing.body).length >
                Buffer.byteLength(f.payload)
    );
    assert.equal(Buffer.from(fake.outgoing.body).includes(f.payload), false);
    assert.equal(fake.outgoing.destroyed, true);
    assert.equal(fake.incoming.destroyed, true);
    assert.deepEqual(Object.values(sent.agent.sockets).flat(), []);
});

void test('the actual Agent lookup pins one complete accepted resolution instead of checking then re-resolving', async () => {
    const f = fixture(),
        outgoing = new ControlledRequest();
    let resolutions = 0;
    const answers = [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
    ];
    const factory: PushRequestFactory = (options, callback) => {
        assert.ok(options.agent instanceof Agent);
        const lookup = options.agent.options.lookup;
        assert.ok(lookup);
        outgoing.onEnd = () =>
            lookup('push.example.test', { all: true }, (error, actual) => {
                assert.equal(error, null);
                assert.deepEqual(actual, answers);
                answers[0]!.address = '127.0.0.1';
                lookup(
                    'push.example.test',
                    { family: 4 },
                    (secondError, address, family) => {
                        assert.equal(secondError, null);
                        assert.equal(address, '8.8.8.8');
                        assert.equal(family, 4);
                        const response = new ControlledResponse();
                        callback(response);
                        response.emit('end');
                    }
                );
            });
        return outgoing;
    };
    await sendNativePush(f.subscription, f.payload, f.options, f.admitted, {
        request: factory,
        lookupAll: (_hostname, callback) => {
            resolutions++;
            callback(null, answers);
        },
    });
    assert.equal(resolutions, 1);
});

void test('non-2xx responses preserve bounded provider status and never follow a Location', async () => {
    const f = fixture(),
        fake = controlledResponse(302, [Buffer.from('redirect refused')], {
            location: 'https://other.example.test/secret',
        });
    let calls = 0;
    await assert.rejects(
        sendNativePush(f.subscription, f.payload, f.options, f.admitted, {
            request: (...args) => {
                calls++;
                return fake.factory(...args);
            },
        }),
        (error: unknown) =>
            error instanceof webPush.WebPushError && error.statusCode === 302
    );
    assert.equal(calls, 1);
    assert.equal(fake.outgoing.destroyed, true);
});

void test('oversized response headers/body and aborted streams refuse and destroy the request', async () => {
    const f = fixture();
    for (const fake of [
        controlledResponse(201, [Buffer.alloc(MAX_PUSH_RESPONSE_BYTES + 1)]),
        controlledResponse(201, [], {
            'x-large': 'x'.repeat(MAX_PUSH_HEADER_BYTES),
        }),
    ]) {
        await assert.rejects(
            sendNativePush(f.subscription, f.payload, f.options, f.admitted, {
                request: fake.factory,
            }),
            (error: unknown) =>
                error instanceof PushTransportError &&
                error.reason === 'RESPONSE_LIMIT'
        );
        assert.equal(fake.outgoing.destroyed, true);
        assert.equal(fake.incoming.destroyed, true);
    }
    const outgoing = new ControlledRequest();
    const factory: PushRequestFactory = (_options, callback) => {
        outgoing.onEnd = () =>
            queueMicrotask(() => {
                const incoming = new ControlledResponse();
                callback(incoming);
                incoming.emit('aborted');
            });
        return outgoing;
    };
    await assert.rejects(
        sendNativePush(f.subscription, f.payload, f.options, f.admitted, {
            request: factory,
        }),
        (error: unknown) =>
            error instanceof PushTransportError && error.reason === 'NETWORK'
    );
    assert.equal(outgoing.destroyed, true);
});

void test('the overall deadline terminates a response that never finishes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(),
        outgoing = new ControlledRequest();
    const pending = sendNativePush(
        f.subscription,
        f.payload,
        f.options,
        f.admitted,
        { request: () => outgoing }
    );
    const rejected = assert.rejects(
        pending,
        (error: unknown) =>
            error instanceof PushTransportError &&
            error.reason === 'TOTAL_TIMEOUT'
    );
    t.mock.timers.tick(PUSH_TOTAL_TIMEOUT_MS);
    await rejected;
    assert.equal(outgoing.destroyed, true);
});

void test('DNS has its own deadline and a late private answer cannot start another request', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(),
        outgoing = new ControlledRequest();
    let late:
        | ((
              error: NodeJS.ErrnoException | null,
              answers: { address: string; family: number }[]
          ) => void)
        | undefined;
    let requests = 0;
    const factory: PushRequestFactory = (options) => {
        requests++;
        assert.ok(options.agent instanceof Agent);
        const lookup = options.agent.options.lookup;
        assert.ok(lookup);
        outgoing.onEnd = () =>
            lookup('push.example.test', { all: true }, (error) => {
                if (error) outgoing.emit('error', error);
            });
        return outgoing;
    };
    const pending = sendNativePush(
        f.subscription,
        f.payload,
        f.options,
        f.admitted,
        {
            request: factory,
            lookupAll: (_hostname, callback) => {
                late = callback;
            },
        }
    );
    const rejected = assert.rejects(
        pending,
        (error: unknown) =>
            error instanceof PushTransportError &&
            error.reason === 'DNS_TIMEOUT'
    );
    t.mock.timers.tick(PUSH_DNS_TIMEOUT_MS);
    await rejected;
    assert.ok(late);
    late(null, [{ address: '127.0.0.1', family: 4 }]);
    assert.equal(requests, 1);
    assert.equal(outgoing.destroyed, true);
});

void test('a mismatched saved endpoint is refused before native request construction', async () => {
    const f = fixture();
    let calls = 0;
    await assert.rejects(
        sendNativePush(
            { ...f.subscription, endpoint: 'https://other.example.test/token' },
            f.payload,
            f.options,
            f.admitted,
            {
                request: () => {
                    calls++;
                    return new ControlledRequest();
                },
            }
        ),
        (error: unknown) =>
            error instanceof PushTransportError &&
            error.reason === 'INVALID_TARGET'
    );
    assert.equal(calls, 0);
});

void test('forged IP-literal or raw-path metadata refuses before DNS or request construction', async () => {
    const f = fixture();
    let calls = 0;
    let lookups = 0;
    for (const admitted of [
        {
            endpoint: 'https://127.0.0.1/private',
            origin: 'https://127.0.0.1',
            hostname: '127.0.0.1',
            requestPath: '/private',
        },
        {
            endpoint: 'https://[::1]/private',
            origin: 'https://[::1]',
            hostname: '[::1]',
            requestPath: '/private',
        },
        { ...f.admitted, requestPath: '/different-private-token' },
    ]) {
        await assert.rejects(
            sendNativePush(
                { ...f.subscription, endpoint: admitted.endpoint },
                f.payload,
                f.options,
                admitted,
                {
                    request: () => {
                        calls++;
                        return new ControlledRequest();
                    },
                    lookupAll: (_hostname, callback) => {
                        lookups++;
                        callback(null, [{ address: '127.0.0.1', family: 4 }]);
                    },
                }
            ),
            (error: unknown) =>
                error instanceof PushTransportError &&
                error.reason === 'INVALID_TARGET'
        );
    }
    assert.equal(calls, 0);
    assert.equal(lookups, 0);
});

/** Real HTTPS listener + real https.request/Agent/DNS callback; only the test port is rewritten. */
void test(
    'private and mixed DNS answers cause zero TCP connections to an owned loopback TLS listener',
    { timeout: 10_000 },
    async () => {
        const server = createServer();
        const sockets = new Set<Socket>();
        let connections = 0;
        server.on('connection', (socket) => {
            connections++;
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        server.on('tlsClientError', () => {});
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const f = fixture();
        try {
            for (const answers of [
                [{ address: '127.0.0.1', family: 4 }],
                [
                    { address: '8.8.8.8', family: 4 },
                    { address: '127.0.0.1', family: 4 },
                ],
            ]) {
                let requests = 0,
                    lookups = 0;
                const factory: PushRequestFactory = (options, callback) => {
                    requests++;
                    assert.equal(options.port, 443);
                    assert.equal(options.rejectUnauthorized, true);
                    assert.equal(options.hostname, 'push.example.test');
                    assert.equal(options.servername, 'push.example.test');
                    // No production private-address bypass: if DNS validation regresses, TCP reaches this listener and the test fails.
                    return request(
                        { ...options, port: address.port },
                        callback
                    );
                };
                await assert.rejects(
                    sendNativePush(
                        f.subscription,
                        f.payload,
                        f.options,
                        f.admitted,
                        {
                            request: factory,
                            lookupAll: (_hostname, callback) => {
                                lookups++;
                                callback(null, answers);
                            },
                        }
                    ),
                    (error: unknown) =>
                        error instanceof PushTransportError &&
                        error.reason === 'DNS_BLOCKED'
                );
                assert.equal(requests, 1);
                assert.equal(lookups, 1);
                assert.equal(connections, 0);
            }
        } finally {
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        }
    }
);
