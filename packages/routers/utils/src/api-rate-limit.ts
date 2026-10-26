import { ORPCError } from '@orpc/server';
import { consumeRateLimit } from '@repo/queues/rate-limit';

/** Request budgets for provider-related operations, never native usage or billing. */
export const PROVIDER_OPERATIONS: ReadonlySet<string> = new Set([
    'admin.rag.indexing.search',
    'admin.rag.reranking.search',
    'admin.rag.indexing.probe',
    'admin.rag.indexing.models',
]);
export const MAX_API_RATE_LIMIT_PER_MINUTE = 1_000_000;

export type ApiRateLimits = Readonly<{
    /** Requests per minute per organization principal; 0 disables this bucket. */
    principal: number;
    /** Admitted provider-operation requests per minute per principal; 0 disables. */
    principalProvider: number;
    /** Admitted provider-operation requests per minute per organization; 0 disables. */
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
    const text = value.trim();
    const parsed = Number(text);
    if (
        !/^\d+$/u.test(text) ||
        !Number.isSafeInteger(parsed) ||
        parsed < 0 ||
        parsed > MAX_API_RATE_LIMIT_PER_MINUTE
    )
        throw new Error(name + ' must be an integer from 0 to 1000000.');
    return parsed;
}

/** Validate all startup budgets without echoing raw configuration; only zero disables. */
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

function principalScope(principal: Principal) {
    const actor = principal.keyId
        ? 'key:' + principal.keyId
        : 'user:' + (principal.userId ?? 'unknown');
    return principal.organizationId + ':' + actor;
}

/** Stop at the first refusal, before touching any later shared bucket. */
async function consumeBudgets(
    checks: readonly (readonly [string, number])[],
    resHeaders: Headers | undefined,
    consume: Consume
) {
    for (const [key, maximum] of checks) {
        if (maximum === 0) continue;
        const decision = await consume(key, 60, maximum, 'FIXED');
        if (decision.allowed) continue;
        resHeaders?.set('Retry-After', String(decision.retryAfterSeconds));
        throw new ORPCError('TOO_MANY_REQUESTS', {
            status: 429,
            message: 'Too many requests. Retry after the indicated delay.',
            data: { retryAfterSeconds: decision.retryAfterSeconds },
        });
    }
}

/** Personal anti-loop budget, charged before operation/resource permission checks. */
export function enforceApiRateLimit(
    principal: Principal,
    limits: ApiRateLimits,
    resHeaders: Headers | undefined,
    consume: Consume = consumeRateLimit
): Promise<void> {
    return consumeBudgets(
        [['api:' + principalScope(principal), limits.principal]],
        resHeaders,
        consume
    );
}

/**
 * Memoize one admission per HTTP request. Services call this only after their
 * resource/binding guards. These counters count admitted operations, not native
 * calls, vectors, successful responses or billing. Later revocation checks stay
 * authoritative and do not refund the request budget.
 */
export function createProviderRateLimitAdmission(
    principal: Principal,
    limits: ApiRateLimits,
    resHeaders: Headers | undefined,
    consume: Consume = consumeRateLimit
): () => Promise<void> {
    let admission: Promise<void> | undefined;
    return () =>
        (admission ??= consumeBudgets(
            [
                [
                    'api-provider:' + principalScope(principal),
                    limits.principalProvider,
                ],
                [
                    'api-provider-org:' + principal.organizationId,
                    limits.organizationProvider,
                ],
            ],
            resHeaders,
            consume
        ));
}
