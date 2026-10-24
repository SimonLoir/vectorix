import type { BetterAuthOptions } from 'better-auth';
import { consumeRateLimit } from '@repo/queues/rate-limit';

type RateLimitRule = {
    window: number;
    max: number;
};

/**
 * Disables rate limiting for read-only organization requests while preserving
 * the active rule for mutations such as invitations, updates, and deletion.
 */
export function getOrganizationRateLimitRule(
    request: Request,
    currentRule: RateLimitRule
) {
    return request.method === 'GET' || request.method === 'HEAD'
        ? false
        : currentRule;
}

/**
 * Internal header carrying the client address the API derived from the socket
 * peer and its trusted proxies. The API overwrites or removes it on every auth
 * request, so a client-supplied value never reaches Better Auth.
 */
export const VECTORIX_CLIENT_IP_HEADER = 'x-vectorix-client-ip';

type RateLimitStorage = NonNullable<
    NonNullable<BetterAuthOptions['rateLimit']>['customStorage']
>;

/**
 * Shares Better Auth's counters across API replicas and restarts through one
 * atomic Redis window per client address and path. Only `consume` is used;
 * `get`/`set` exist for the storage contract's legacy fallback.
 */
export const authRateLimitStorage: RateLimitStorage = {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    async consume(key, rule) {
        const decision = await consumeRateLimit(
            `auth:${key}`,
            rule.window,
            rule.max
        );
        return {
            allowed: decision.allowed,
            retryAfter: decision.allowed ? null : decision.retryAfterSeconds,
        };
    },
};

const secondFactorRule = { window: 300, max: 10 };

/**
 * Excludes high-frequency session and organization reads from Better Auth's
 * limiter. Authentication and organization mutations remain rate limited, and
 * second-factor verification and password-reset completion get stricter
 * five-minute budgets on top of Better Auth's built-in sign-in rules.
 */
export const authRateLimitOptions = {
    customStorage: authRateLimitStorage,
    customRules: {
        '/get-session': false,
        '/organization/*': getOrganizationRateLimitRule,
        '/two-factor/verify-totp': secondFactorRule,
        '/two-factor/verify-otp': secondFactorRule,
        '/two-factor/verify-backup-code': secondFactorRule,
        '/reset-password': { window: 300, max: 5 },
    },
} satisfies NonNullable<BetterAuthOptions['rateLimit']>;

/** Better Auth reads the client address only from the API-derived header. */
export const authIpAddressOptions = {
    ipAddressHeaders: [VECTORIX_CLIENT_IP_HEADER],
} satisfies NonNullable<
    NonNullable<BetterAuthOptions['advanced']>['ipAddress']
>;
