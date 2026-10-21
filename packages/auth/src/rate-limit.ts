import type { BetterAuthOptions } from 'better-auth';

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
 * Excludes high-frequency session and organization reads from Better Auth's
 * limiter. Authentication and organization mutations remain rate limited.
 */
export const authRateLimitOptions = {
    customRules: {
        '/get-session': false,
        '/organization/*': getOrganizationRateLimitRule,
    },
} satisfies NonNullable<BetterAuthOptions['rateLimit']>;
