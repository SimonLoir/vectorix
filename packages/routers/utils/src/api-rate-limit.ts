import { ORPCError } from '@orpc/server';
import { consumeRateLimit } from '@repo/queues/rate-limit';

/** Operations that call a paid or shared embedding provider per request. */
export const PROVIDER_OPERATIONS: ReadonlySet<string> = new Set([
    'admin.rag.indexing.search',
    'admin.rag.indexing.probe',
    'admin.rag.indexing.models',
]);

export type ApiRateLimits = Readonly<{
    /** Requests per minute per organization principal; 0 disables. */
    principal: number;
    /** Provider-backed requests per minute per organization principal. */
    principalProvider: number;
    /** Provider-backed requests per minute shared by the whole organization. */
    organizationProvider: number;
}>;

const DEFAULTS: ApiRateLimits = {
    principal: 600,
    principalProvider: 60,
    organizationProvider: 300,
};

function limit(
    name: string,
    value: string | undefined,
    fallback: number
): number {
    if (value === undefined || value.trim() === '') return fallback;
    if (!/^\d+$/u.test(value.trim()))
        throw new Error(`${name} must be a non-negative integer.`);
    return Number(value.trim());
}

/**
 * Read the per-minute budgets once. Invalid values fail at startup; 0 turns a
 * bucket off. Defaults are generous for dashboards and strict for provider calls.
 */
export function parseApiRateLimits(
    environment: Readonly<Record<string, string | undefined>>
): ApiRateLimits {
    return {
        principal: limit(
            'VECTORIX_API_RATE_LIMIT_PER_MINUTE',
            environment.VECTORIX_API_RATE_LIMIT_PER_MINUTE,
            DEFAULTS.principal
        ),
        principalProvider: limit(
            'VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE',
            environment.VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE,
            DEFAULTS.principalProvider
        ),
        organizationProvider: limit(
            'VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE',
            environment.VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE,
            DEFAULTS.organizationProvider
        ),
    };
}

type Principal = Readonly<{
    organizationId: string;
    keyId: string | null;
    userId: string | null;
}>;

type Consume = typeof consumeRateLimit;

/**
 * Count one authenticated v1 request against its budgets and throw
 * TOO_MANY_REQUESTS (429) with `Retry-After` when any is exhausted. Every
 * applicable bucket is counted, so retries during a denial still spend the
 * principal budget. Keys hold only opaque identifiers.
 */
export async function enforceApiRateLimit(
    principal: Principal,
    operation: string,
    limits: ApiRateLimits,
    resHeaders: Headers | undefined,
    consume: Consume = consumeRateLimit
): Promise<void> {
    const actor = principal.keyId
        ? `key:${principal.keyId}`
        : `user:${principal.userId ?? 'unknown'}`;
    const scope = `${principal.organizationId}:${actor}`;
    const checks: [string, number][] = [[`api:${scope}`, limits.principal]];
    if (PROVIDER_OPERATIONS.has(operation))
        checks.push(
            [`api-provider:${scope}`, limits.principalProvider],
            [
                `api-provider-org:${principal.organizationId}`,
                limits.organizationProvider,
            ]
        );
    let retryAfter = 0;
    for (const [key, max] of checks) {
        if (max <= 0) continue;
        const decision = await consume(key, 60, max);
        if (!decision.allowed)
            retryAfter = Math.max(retryAfter, decision.retryAfterSeconds);
    }
    if (retryAfter === 0) return;
    resHeaders?.set('Retry-After', String(retryAfter));
    throw new ORPCError('TOO_MANY_REQUESTS', {
        status: 429,
        message: 'Too many requests. Retry after the indicated delay.',
        data: { retryAfterSeconds: retryAfter },
    });
}
