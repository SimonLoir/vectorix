import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearExternalVectorixEntitlementsCache,
    getExternalVectorixEntitlements,
} from './external-provider';

const fetchMock = vi.fn<typeof fetch>();

const respond = (payload: unknown, status = 200) => {
    fetchMock.mockImplementation(() =>
        Promise.resolve(Response.json(payload, { status }))
    );
};

describe('authoritative generic feature provider', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubEnv(
            'VECTORIX_FEATURE_PROVIDER_URL',
            'https://features.example.test/api'
        );
        vi.stubEnv('VECTORIX_FEATURE_PROVIDER_TOKEN', 'fictional-secret');
        vi.stubEnv('VECTORIX_FEATURE_PROVIDER_CACHE_TTL_MS', '60000');
        fetchMock.mockReset();
        clearExternalVectorixEntitlementsCache();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('performs an organization-scoped read with bearer credentials and caches valid grants', async () => {
        respond({ features: { reporting: true } });
        const result = await getExternalVectorixEntitlements('org/a');
        expect(result).toMatchObject({
            configured: true,
            reachable: true,
            features: { reporting: true },
        });
        expect(fetchMock).toHaveBeenCalledWith(
            new URL(
                'https://features.example.test/api/organizations/org%2Fa/features'
            ),
            expect.objectContaining({
                headers: {
                    accept: 'application/json',
                    authorization: 'Bearer fictional-secret',
                },
            })
        );
        await getExternalVectorixEntitlements('org/a');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('never caches grants past their entitlement deadline', async () => {
        respond({
            features: { reporting: true },
            expiresAt: '2026-09-09T12:00:01Z',
        });
        expect(
            (await getExternalVectorixEntitlements('org-1')).features
        ).toEqual({ reporting: true });
        vi.advanceTimersByTime(1000);
        const expired = await getExternalVectorixEntitlements('org-1');
        expect(expired).toMatchObject({
            reachable: true,
            features: {},
            expiresAt: '2026-09-09T12:00:01Z',
        });
        expect(expired.error).toBe(
            'External feature entitlements have expired.'
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('accounts for a grant expiring during the HTTP request itself', async () => {
        fetchMock.mockImplementation(() => {
            vi.advanceTimersByTime(2000);
            return Promise.resolve(
                Response.json({
                    features: { reporting: true },
                    expiresAt: '2026-09-09T12:00:01Z',
                })
            );
        });
        expect(
            (await getExternalVectorixEntitlements('org-1')).features
        ).toEqual({});
    });

    it('does not reuse credentials or entitlements after the provider URL changes', async () => {
        respond({ features: { reporting: true } });
        await getExternalVectorixEntitlements('org-1');
        vi.stubEnv(
            'VECTORIX_FEATURE_PROVIDER_URL',
            'https://other.example.test'
        );
        respond({ features: { analytics: true } });
        expect(
            (await getExternalVectorixEntitlements('org-1')).features
        ).toEqual({ analytics: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not reuse entitlements after rotating the provider token', async () => {
        respond({ features: { reporting: true } });
        await getExternalVectorixEntitlements('org-1');
        vi.stubEnv(
            'VECTORIX_FEATURE_PROVIDER_TOKEN',
            'another-fictional-secret'
        );
        respond({ features: {} });
        expect(
            (await getExternalVectorixEntitlements('org-1')).features
        ).toEqual({});
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps caches separate across organizations and supports scoped invalidation', async () => {
        respond({ features: { reporting: true } });
        await getExternalVectorixEntitlements('org-1');
        await getExternalVectorixEntitlements('org-2');
        clearExternalVectorixEntitlementsCache('org-1');
        await getExternalVectorixEntitlements('org-2');
        await getExternalVectorixEntitlements('org-1');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not query an absent provider or restore a cached grant after disconnect', async () => {
        respond({ features: { reporting: true } });
        await getExternalVectorixEntitlements('org-1');
        vi.stubEnv('VECTORIX_FEATURE_PROVIDER_URL', '');
        const result = await getExternalVectorixEntitlements('org-1');
        expect(result).toEqual({
            configured: false,
            reachable: false,
            features: {},
            expiresAt: null,
            error: null,
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it.each([
        { payload: { features: { reporting: 'true' } }, status: 200 },
        {
            payload: { features: { reporting: true }, expiresAt: 'malformed' },
            status: 200,
        },
        { payload: { features: { reporting: true } }, status: 503 },
    ])(
        'denies invalid or failed responses: %j',
        async ({ payload, status }) => {
            respond(payload, status);
            const result = await getExternalVectorixEntitlements('org-1');
            expect(result).toEqual({
                configured: true,
                reachable: false,
                features: {},
                expiresAt: null,
                error: 'The external feature provider is unavailable or returned invalid entitlements.',
            });
        }
    );

    it('sanitizes network failures and never exposes a provider token or remote error body', async () => {
        fetchMock.mockRejectedValue(
            new Error('fictional-secret sensitive remote response')
        );
        const result = await getExternalVectorixEntitlements('org-1');
        expect(result.features).toEqual({});
        expect(result.error).not.toContain('fictional-secret');
        expect(result.error).not.toContain('sensitive remote response');
    });
});
