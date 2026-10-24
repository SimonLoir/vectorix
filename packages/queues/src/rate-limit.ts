import { Redis } from 'ioredis';
import { connection } from './index';

/** Outcome of counting one request against a fixed window. */
export type RateLimitDecision = Readonly<{
    allowed: boolean;
    /** Seconds until the current window ends; 0 when allowed. */
    retryAfterSeconds: number;
}>;

const KEY_PREFIX = 'vectorix:rate-limit:';
const FALLBACK_MAX_ENTRIES = 10_000;
// INCR and PEXPIRE run atomically, so every replica shares one counter per window.
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

let client: Redis | undefined;
let fallbackWarned = false;
const fallback = new Map<string, { count: number; resetAt: number }>();

function redis(): Redis {
    client ??= new Redis({
        ...connection,
        // Rate limiting must answer quickly; a slow or absent Redis uses the local fallback.
        maxRetriesPerRequest: 1,
        commandTimeout: 500,
        connectTimeout: 2000,
    });
    return client;
}

function decide(count: number, ttlMs: number, max: number): RateLimitDecision {
    return count <= max
        ? { allowed: true, retryAfterSeconds: 0 }
        : {
              allowed: false,
              retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
          };
}

function consumeLocally(
    key: string,
    windowMs: number,
    max: number
): RateLimitDecision {
    const now = Date.now();
    if (fallback.size >= FALLBACK_MAX_ENTRIES)
        for (const [entryKey, entry] of fallback)
            if (entry.resetAt <= now) fallback.delete(entryKey);
    if (fallback.size >= FALLBACK_MAX_ENTRIES) fallback.clear();
    const current = fallback.get(key);
    const entry =
        current && current.resetAt > now
            ? { ...current, count: current.count + 1 }
            : { count: 1, resetAt: now + windowMs };
    fallback.set(key, entry);
    return decide(entry.count, entry.resetAt - now, max);
}

/**
 * Count one request for `key` in a fixed window shared by every process
 * through Redis. If Redis is unavailable the decision falls back to a bounded
 * per-process window, so limits degrade to per-replica rather than disappear;
 * one sanitized warning is logged. Keys must not contain secrets.
 */
export async function consumeRateLimit(
    key: string,
    windowSeconds: number,
    max: number
): Promise<RateLimitDecision> {
    const windowMs = Math.max(1, Math.round(windowSeconds * 1000));
    try {
        const [count, ttl] = (await redis().eval(
            CONSUME_SCRIPT,
            1,
            `${KEY_PREFIX}${key}`,
            windowMs
        )) as [number, number];
        return decide(Number(count), Number(ttl), max);
    } catch {
        if (!fallbackWarned) {
            fallbackWarned = true;
            console.warn(
                '[rate-limit] Redis is unavailable; using per-process limits until it recovers.'
            );
        }
        return consumeLocally(key, windowMs, max);
    }
}

/** Close the shared rate-limit connection during graceful shutdown. */
export async function closeRateLimitStore(): Promise<void> {
    const current = client;
    client = undefined;
    await current?.quit().catch(() => current.disconnect());
}
