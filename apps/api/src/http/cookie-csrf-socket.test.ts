import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cookieCsrfProtection } from './cookie-csrf';

const version = {
    major: 1,
    revision: 19,
    status: 'current',
    rpcPath: '/rpc/v1',
    restPath: '/api/v1',
} as const;
const forbidden = {
    defined: false,
    code: 'FORBIDDEN',
    status: 403,
    message: 'Request origin is not allowed.',
};

/** Decode only the bounded ASCII refusal, including the Node adapter's chunk framing. */
function refusalBody(response: string, separator: number) {
    const body = response.slice(separator + 4);
    if (!/^transfer-encoding: chunked\r?$/im.test(response.slice(0, separator)))
        return body;
    const chunks: string[] = [];
    let offset = 0;
    while (true) {
        const lineEnd = body.indexOf('\r\n', offset);
        assert.ok(lineEnd >= offset);
        const size = body.slice(offset, lineEnd);
        assert.match(size, /^[0-9a-f]+$/i);
        const bytes = Number.parseInt(size, 16);
        offset = lineEnd + 2;
        if (bytes === 0) {
            assert.equal(body.slice(offset), '\r\n');
            return chunks.join('');
        }
        chunks.push(body.slice(offset, offset + bytes));
        assert.equal(body.slice(offset + bytes, offset + bytes + 2), '\r\n');
        offset += bytes + 2;
    }
}

void test(
    'the Node adapter returns cookie-CSRF refusals before multipart parsing and disposes unfinished input',
    { timeout: 10_000 },
    async (t) => {
        const app = new Hono();
        let bodyReaders = 0,
            handlers = 0,
            mutations = 0;
        app.use(
            '*',
            cookieCsrfProtection([version], ['https://web.example.test'])
        );
        app.use('*', async (context, next) => {
            bodyReaders++;
            await context.req.raw.formData();
            await next();
        });
        app.post('/rpc/v1/private', (context) => {
            handlers++;
            mutations++;
            return context.json({ success: true });
        });
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
            await t.test(
                'a native FormData upload receives the fixed refusal',
                async () => {
                    const form = new FormData();
                    form.set(
                        'file',
                        new File(['Private multipart bytes.\n'], 'fixture.txt')
                    );
                    const response = await fetch(
                        `http://127.0.0.1:${address.port}/rpc/v1/private`,
                        {
                            method: 'POST',
                            headers: {
                                cookie: 'synthetic=present',
                                origin: 'https://hostile.example.test',
                            },
                            body: form,
                            signal: AbortSignal.timeout(3000),
                        }
                    );
                    assert.equal(response.status, 403);
                    assert.equal(
                        response.headers.get('Vectorix-API-Revision'),
                        '19'
                    );
                    assert.deepEqual(await response.json(), {
                        json: forbidden,
                    });
                    assert.deepEqual(
                        [bodyReaders, handlers, mutations],
                        [0, 0, 0]
                    );
                    // node:test itself fails on any unhandled rejection; no global
                    // rejection handler suppresses a late multipart encoder failure.
                }
            );
            await t.test(
                'unfinished multipart receives 403 and its socket closes without a client EOF',
                async () => {
                    const socket = createConnection({
                        host: '127.0.0.1',
                        port: address.port,
                    });
                    try {
                        let responseBeforeClientEnd = false;
                        const wire = new Promise<Buffer>((resolve, reject) => {
                            const chunks: Buffer[] = [];
                            let bytes = 0;
                            socket.on('data', (chunk: Buffer) => {
                                responseBeforeClientEnd ||=
                                    !socket.writableEnded;
                                bytes += chunk.length;
                                if (bytes > 8192)
                                    socket.destroy(
                                        new Error('Unexpected refusal size.')
                                    );
                                else chunks.push(chunk);
                            });
                            socket.once('error', reject);
                            socket.once('close', () =>
                                resolve(Buffer.concat(chunks))
                            );
                        });
                        socket.setTimeout(3000, () =>
                            socket.destroy(
                                new Error('Unread input was not disposed.')
                            )
                        );
                        // Declare much more than is sent and never call end(): only
                        // adapter cleanup can release this intentionally open input.
                        socket.write(
                            `POST /rpc/v1/private HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nCookie: synthetic=present\r\nOrigin: https://hostile.example.test\r\nContent-Type: multipart/form-data; boundary=unfinished\r\nContent-Length: 65536\r\nConnection: keep-alive\r\n\r\n--unfinished\r\n`
                        );
                        const response = (await wire).toString('utf8');
                        const separator = response.indexOf('\r\n\r\n');
                        assert.ok(separator > 0);
                        assert.match(
                            response.slice(0, separator),
                            /^HTTP\/1\.1 403 /
                        );
                        assert.deepEqual(
                            JSON.parse(refusalBody(response, separator)),
                            {
                                json: forbidden,
                            }
                        );
                        assert.equal(responseBeforeClientEnd, true);
                        assert.equal(socket.destroyed, true);
                        assert.deepEqual(
                            [bodyReaders, handlers, mutations],
                            [0, 0, 0]
                        );
                    } finally {
                        socket.destroy();
                    }
                }
            );
        } finally {
            for (const socket of sockets) socket.destroy();
            if ('closeAllConnections' in server) server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
        }
    }
);
