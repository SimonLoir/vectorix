import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { twoFactor } from 'better-auth/plugins';
import { Hono } from 'hono';
import {
    authRateLimitOptions,
    authIpAddressOptions,
} from '@repo/auth/rate-limit';
import { closeRateLimitStore } from '@repo/queues/rate-limit';
import {
    parseTrustedProxies,
    resolveClientIp,
    withClientIp,
} from './client-ip';

const target = new URL(process.env.REDIS_URL ?? 'redis://invalid');
if (
    process.env.VECTORIX_RATE_LIMIT_WORKER !== '1' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/15' ||
    !process.send
)
    throw new Error(
        'Run native rate-limit workers through the isolated Redis test.'
    );

const auth = betterAuth({
    baseURL: 'http://127.0.0.1:3001',
    secret: 'vectorix-native-rate-limit-test-only-secret-32-characters',
    database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        twoFactor: [],
    }),
    trustedOrigins: ['http://native-rate-limit.example.test'],
    emailAndPassword: { enabled: true },
    advanced: { ipAddress: authIpAddressOptions },
    rateLimit: { ...authRateLimitOptions, enabled: true },
    plugins: [twoFactor()],
});
const app = new Hono();
const proxies = parseTrustedProxies(process.env.VECTORIX_TRUSTED_PROXIES);
app.on(['GET', 'POST'], '/api/auth/*', (context) => {
    const ip = resolveClientIp(
        getConnInfo(context).remote.address,
        context.req.header('x-forwarded-for') ?? null,
        proxies
    );
    return auth.handler(withClientIp(context.req.raw, ip));
});
const server = serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
    ({ port }) => {
        process.send?.({ port });
    }
);
let stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    void closeRateLimitStore().then(() => {
        server.close(() => {
            if (process.connected) process.disconnect?.();
            process.exitCode = 0;
        });
        setTimeout(() => {
            throw new Error('Native test worker did not stop.');
        }, 2000).unref();
    });
}
process.on('message', (message: unknown) => {
    if (message === 'stop') stop();
});
process.on('disconnect', stop);
process.on('SIGTERM', stop);
