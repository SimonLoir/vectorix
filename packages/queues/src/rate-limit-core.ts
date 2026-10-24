/** The same decision returned by Redis and the bounded local outage store. */
export type RateLimitDecision = Readonly<{
    allowed: boolean;
    retryAfterSeconds: number;
}>;

const DEFAULT_MAX_ENTRIES = 10_000;
const PRUNE_STEPS = 64;
type Entry = { count: number; resetAt: number };

/**
 * Preserve Better Auth's last-allowed-request window atomically. Rejected
 * requests do not increase the count or prolong the cooldown. The v2 Redis
 * namespace keeps this representation separate from the previous fixed window.
 */
export const RATE_LIMIT_CONSUME_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
local window = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
if not raw then
    redis.call('SET', KEYS[1], '1', 'PX', window)
    return {1, window}
end
local count = tonumber(raw)
if not count or count < 1 or ttl < 0 then
    return redis.error_reply('INVALID_RATE_LIMIT_COUNTER')
end
if count >= maximum then return {0, ttl} end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window)
return {1, window}
`;

function denied(ttlMs: number): RateLimitDecision {
    return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
}

/**
 * Bounded outage fallback. Saturation denies new keys instead of evicting live
 * security budgets; an incremental sweep examines at most 64 entries per call.
 * This remains a per-process fallback, not a distributed availability guarantee.
 */
export function createLocalRateLimitStore({
    now = Date.now,
    maxEntries = DEFAULT_MAX_ENTRIES,
}: { now?: () => number; maxEntries?: number } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
        throw new Error('Rate-limit capacity is invalid.');
    const entries = new Map<string, Entry>();
    let sweep = entries.entries();
    function prune(time: number) {
        for (let step = 0; step < PRUNE_STEPS; step++) {
            const next = sweep.next();
            if (next.done) {
                sweep = entries.entries();
                break;
            }
            if (next.value[1].resetAt <= time) entries.delete(next.value[0]);
        }
    }
    return {
        consume(key: string, windowMs: number, max: number): RateLimitDecision {
            const time = now();
            const current = entries.get(key);
            if (current && current.resetAt > time) {
                if (current.count >= max) return denied(current.resetAt - time);
                current.count++;
                current.resetAt = time + windowMs;
                return { allowed: true, retryAfterSeconds: 0 };
            }
            if (current) entries.delete(key);
            prune(time);
            if (entries.size >= maxEntries) return denied(windowMs);
            entries.set(key, { count: 1, resetAt: time + windowMs });
            return { allowed: true, retryAfterSeconds: 0 };
        },
    };
}

/** Decode only the numeric result emitted by the owned Lua script. */
export function readRateLimitDecision(value: unknown): RateLimitDecision {
    if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        (value[0] !== 0 && value[0] !== 1) ||
        typeof value[1] !== 'number' ||
        !Number.isSafeInteger(value[1]) ||
        value[1] < 0
    )
        throw new Error('Rate-limit response is invalid.');
    return value[0] === 1
        ? { allowed: true, retryAfterSeconds: 0 }
        : denied(value[1]);
}
