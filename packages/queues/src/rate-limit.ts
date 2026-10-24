import { Redis } from 'ioredis';
import { connection } from './index';
import {
    createLocalRateLimitStore,
    RATE_LIMIT_CONSUME_SCRIPT,
    readRateLimitDecision,
    type RateLimitDecision,
} from './rate-limit-core';
export type { RateLimitDecision } from './rate-limit-core';

const KEY_PREFIX = 'vectorix:rate-limit:v2:';
const RECONNECT_DELAY_MS = 5000;
const fallback = createLocalRateLimitStore();
let client: Redis | undefined;
let connecting: Promise<Redis> | undefined;
let nextConnectAt = 0;
let warned = false;
let closed = false;

function warnUnavailable() {
    if (warned) return;
    warned = true;
    // Never pass an ioredis error, key, URL or stack to the logger.
    try {
        console.warn(
            '[rate-limit] Redis is unavailable; using bounded per-process limits until it recovers.'
        );
    } catch {
        // A diagnostic failure must not bypass the fallback decision.
    }
}

/** One bounded connection attempt at a time, with no background retry loop. */
function redis(): Promise<Redis> {
    if (closed) return Promise.reject(new Error('Rate-limit store is closed.'));
    if (client?.status === 'ready') return Promise.resolve(client);
    if (connecting) return connecting;
    if (Date.now() < nextConnectAt)
        return Promise.reject(new Error('Rate-limit store is unavailable.'));
    nextConnectAt = Date.now() + RECONNECT_DELAY_MS;
    client?.disconnect();
    const current = new Redis({
        ...connection,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 500,
        connectTimeout: 2000,
        retryStrategy: () => null,
    });
    // Attach before connect: ioredis otherwise prints raw error.stack itself.
    current.on('error', warnUnavailable);
    client = current;
    connecting = current
        .connect()
        .then(() => current)
        .catch(() => {
            current.disconnect();
            throw new Error('Rate-limit store is unavailable.');
        })
        .finally(() => {
            connecting = undefined;
        });
    return connecting;
}

/**
 * Count against the native last-allowed-request window using one Redis script.
 * On failure, retain bounded per-process budgets. Redis reconnects are attempted
 * by requests at most once per five seconds; only one fixed warning is emitted.
 * Callers must hash keys that might contain credentials or identifying paths.
 */
export async function consumeRateLimit(
    key: string,
    windowSeconds: number,
    max: number
): Promise<RateLimitDecision> {
    const windowMs = Math.round(windowSeconds * 1000);
    if (
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1 ||
        !Number.isSafeInteger(max) ||
        max < 1
    )
        throw new Error('Rate-limit rule is invalid.');
    try {
        const shared = await redis();
        const result: unknown = await shared.eval(
            RATE_LIMIT_CONSUME_SCRIPT,
            1,
            `${KEY_PREFIX}${key}`,
            windowMs,
            max
        );
        return readRateLimitDecision(result);
    } catch {
        warnUnavailable();
        return fallback.consume(key, windowMs, max);
    }
}

/** Disconnect immediately and stop all future connection attempts on shutdown. */
export function closeRateLimitStore(): Promise<void> {
    closed = true;
    client?.disconnect();
    client = undefined;
    return Promise.resolve();
}
