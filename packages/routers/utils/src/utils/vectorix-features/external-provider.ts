import { z } from 'zod';
import type { ExternalVectorixEntitlementsResult } from './types';

const externalEntitlementsSchema = z.object({
    features: z.record(z.string(), z.boolean()),
    expiresAt: z.string().datetime().nullable().optional(),
});

const cache = new Map<
    string,
    {
        expiresAt: number;
        providerUrl: string;
        token: string | undefined;
        value: ExternalVectorixEntitlementsResult;
    }
>();

const readPositiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getProviderUrl = () => {
    const providerUrl = process.env.VECTORIX_FEATURE_PROVIDER_URL?.trim();
    return providerUrl?.length ? providerUrl : undefined;
};

/**
 * Reads organization entitlements from the optional external feature provider.
 * Results are cached briefly so route guards do not call the billing service on
 * every request. A cached grant never outlives its entitlement expiry or its
 * connection credentials. Provider failures contain no grants: the resolver
 * must deny access rather than fall back to local defaults/plans/overrides.
 */
export async function getExternalVectorixEntitlements(
    organizationId: string
): Promise<ExternalVectorixEntitlementsResult> {
    const providerUrl = getProviderUrl();
    if (!providerUrl) {
        return {
            configured: false,
            reachable: false,
            features: {},
            expiresAt: null,
            error: null,
        };
    }

    const now = Date.now();
    const token = process.env.VECTORIX_FEATURE_PROVIDER_TOKEN?.trim();
    const cached = cache.get(organizationId);
    if (
        cached &&
        cached.expiresAt > now &&
        cached.providerUrl === providerUrl &&
        cached.token === token
    ) {
        return cached.value;
    }

    const timeoutMs = readPositiveInteger(
        process.env.VECTORIX_FEATURE_PROVIDER_TIMEOUT_MS,
        3000
    );
    const cacheTtlMs = readPositiveInteger(
        process.env.VECTORIX_FEATURE_PROVIDER_CACHE_TTL_MS,
        60_000
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const baseUrl = providerUrl.endsWith('/')
            ? providerUrl
            : `${providerUrl}/`;
        const endpoint = new URL(
            `organizations/${encodeURIComponent(organizationId)}/features`,
            baseUrl
        );
        const response = await fetch(endpoint, {
            headers: {
                accept: 'application/json',
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(
                `Feature provider returned HTTP ${response.status}`
            );
        }

        const payload = externalEntitlementsSchema.parse(await response.json());
        const entitlementExpiresAt = payload.expiresAt
            ? Date.parse(payload.expiresAt)
            : Infinity;
        const expired = entitlementExpiresAt <= Date.now();
        const result: ExternalVectorixEntitlementsResult = {
            configured: true,
            reachable: true,
            features: expired ? {} : payload.features,
            expiresAt: payload.expiresAt ?? null,
            error: expired
                ? 'External feature entitlements have expired.'
                : null,
        };
        cache.set(organizationId, {
            expiresAt: Math.min(now + cacheTtlMs, entitlementExpiresAt),
            providerUrl,
            token,
            value: result,
        });
        return result;
    } catch {
        return {
            configured: true,
            reachable: false,
            features: {},
            expiresAt: null,
            error: 'The external feature provider is unavailable or returned invalid entitlements.',
        };
    } finally {
        clearTimeout(timeout);
    }
}

/** Clears cached external entitlements after an explicit provider refresh. */
export function clearExternalVectorixEntitlementsCache(
    organizationId?: string
) {
    if (organizationId) {
        cache.delete(organizationId);
        return;
    }

    cache.clear();
}
