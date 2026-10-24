import { createHash } from 'node:crypto';
import type { BetterAuthOptions } from 'better-auth';
import { consumeRateLimit } from '@repo/queues/rate-limit';

type RateLimitRule = { window: number; max: number };

/** Preserve the framework-selected mutation rule; organization reads are exempt. */
export function getOrganizationRateLimitRule(
    request: Request,
    currentRule: RateLimitRule
) {
    return request.method === 'GET' || request.method === 'HEAD'
        ? false
        : currentRule;
}

/** Internal socket-derived address header, overwritten by the API auth route. */
export const VECTORIX_CLIENT_IP_HEADER = 'x-vectorix-client-ip';

type RateLimitStorage = NonNullable<
    NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

/**
 * Hash the complete framework-canonical IP/path key. Native token-bearing paths
 * such as /reset-password/:token must never appear in Redis keys or diagnostics.
 */
export function hashAuthRateLimitKey(key: string): string {
    return `auth:${createHash('sha256').update(key).digest('hex')}`;
}

/** Build the native atomic storage adapter; injection is for focused pure tests. */
export function createAuthRateLimitStorage(
    consume: typeof consumeRateLimit = consumeRateLimit
): RateLimitStorage {
    return {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        async consume(key, rule) {
            const decision = await consume(
                hashAuthRateLimitKey(key),
                rule.window,
                rule.max
            );
            return {
                allowed: decision.allowed,
                retryAfter: decision.allowed
                    ? null
                    : decision.retryAfterSeconds,
            };
        },
    };
}

export const authRateLimitStorage = createAuthRateLimitStorage();

/**
 * Exempt high-frequency reads and tighten password-reset completion. Second
 * factor rules remain selected by the installed native plugin, without custom
 * overrides that would replace its short-window verification limit.
 */
export const authRateLimitOptions = {
    customStorage: authRateLimitStorage,
    customRules: {
        '/get-session': false,
        '/organization/*': getOrganizationRateLimitRule,
        '/reset-password': { window: 300, max: 5 },
    },
} satisfies NonNullable<BetterAuthOptions['rateLimit']>;

/** Better Auth reads the client address only from the API-derived header. */
export const authIpAddressOptions = {
    ipAddressHeaders: [VECTORIX_CLIENT_IP_HEADER],
} satisfies NonNullable<
    NonNullable<BetterAuthOptions['advanced']>['ipAddress']
>;
