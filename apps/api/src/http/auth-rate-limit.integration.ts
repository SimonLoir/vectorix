import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

const target = new URL(process.env.REDIS_URL ?? 'redis://invalid');
if (
    process.env.VECTORIX_REDIS_ISOLATED_TEST !== '1' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/15'
)
    throw new Error('Run native rate-limit tests through pnpm test:queues.');

async function startReplica() {
    const child = fork(
        new URL('auth-rate-limit-worker.ts', import.meta.url),
        [],
        {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            execArgv: ['--import', 'tsx'],
            env: {
                PATH: process.env.PATH,
                NODE_ENV: 'production',
                REDIS_URL: process.env.REDIS_URL,
                REDIS_PASSWORD: process.env.REDIS_PASSWORD,
                VECTORIX_RATE_LIMIT_WORKER: '1',
            },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        }
    );
    // Do not forward raw library stderr, URLs or credentials into assertion output.
    let stderrBytes = 0;
    child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
    });
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('Native test replica did not start.')),
            10_000
        );
        child.once('message', (message: unknown) => {
            clearTimeout(timer);
            if (
                message &&
                typeof message === 'object' &&
                'port' in message &&
                typeof message.port === 'number' &&
                Number.isInteger(message.port) &&
                message.port > 0
            )
                resolve(message.port);
            else
                reject(
                    new Error(
                        'Native test replica returned an invalid ready message.'
                    )
                );
        });
        child.once('error', () => {
            clearTimeout(timer);
            reject(new Error('Native test replica failed.'));
        });
        child.once('exit', () => {
            clearTimeout(timer);
            reject(new Error('Native test replica stopped early.'));
        });
    }).catch(async (error: unknown) => {
        await stopReplica(child);
        throw error;
    });
    return { child, port, stderrBytes: () => stderrBytes };
}

async function stopReplica(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    if (child.connected) child.send('stop');
    else child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try {
        await exited;
    } finally {
        clearTimeout(timer);
    }
}

void test(
    'separate native HTTP replicas share the unchanged plugin budget and ignore spoofed addresses',
    { timeout: 40_000 },
    async () => {
        const replicas: Awaited<ReturnType<typeof startReplica>>[] = [];
        const redis = new Redis(target.href, {
            lazyConnect: true,
            retryStrategy: () => null,
        });
        // The test must not print raw Redis errors either.
        redis.on('error', () => {});
        try {
            for (let count = 0; count < 2; count++)
                replicas.push(await startReplica());
            for (const path of [
                '/two-factor/verify-totp',
                '/two-factor/verify-otp',
                '/two-factor/verify-backup-code',
            ]) {
                for (let index = 0; index < 4; index++) {
                    const replica = replicas[index % 2]!;
                    const response = await fetch(
                        `http://127.0.0.1:${replica.port}/api/auth${path}`,
                        {
                            method: 'POST',
                            headers: {
                                'content-type': 'application/json',
                                origin: 'http://native-rate-limit.example.test',
                                'x-forwarded-for': `198.51.100.${index + 1}`,
                                'x-vectorix-client-ip': `203.0.113.${index + 1}`,
                            },
                            body: JSON.stringify({ code: '000000' }),
                            signal: AbortSignal.timeout(5000),
                        }
                    );
                    const body: unknown = await response.json();
                    if (index < 3) {
                        assert.ok(
                            response.status === 400 || response.status === 401,
                            'The real native verification route must reject the missing challenge before the rate budget is exhausted.'
                        );
                        assert.ok(
                            body && typeof body === 'object' && 'code' in body
                        );
                    } else {
                        assert.equal(response.status, 429);
                        assert.ok(
                            Number(response.headers.get('x-retry-after')) >= 1
                        );
                    }
                }
            }
            // Native path tokens are hashed before reaching shared Redis, including
            // the supported password-reset callback even when its input is invalid.
            const response = await fetch(
                `http://127.0.0.1:${replicas[0]!.port}/api/auth/reset-password/PRIVATE_TOKEN_SENTINEL`,
                { redirect: 'manual', signal: AbortSignal.timeout(5000) }
            );
            await response.arrayBuffer();
            await redis.connect();
            const keys = await redis.keys('vectorix:rate-limit:v2:auth:*');
            assert.ok(keys.length >= 4);
            for (const key of keys)
                assert.match(
                    key,
                    /^vectorix:rate-limit:v2:auth:[a-f0-9]{64}$/u
                );
            assert.equal(
                replicas.some((replica) => replica.stderrBytes() > 0),
                false,
                'Healthy native replicas must not emit raw infrastructure errors.'
            );
        } finally {
            redis.disconnect();
            await Promise.all(replicas.map(({ child }) => stopReplica(child)));
        }
    }
);
