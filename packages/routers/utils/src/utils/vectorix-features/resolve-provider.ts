import { getExternalVectorixEntitlements } from './external-provider';
import type { VectorixFeatureSource, ResolvedVectorixFeatures } from './types';

type FeatureProviderResolution = {
    source: VectorixFeatureSource;
    isEnabled: (key: string, externalKey: string | null) => boolean;
    providers: ResolvedVectorixFeatures['providers'];
};

/**
 * Resolves one authoritative source. Legacy uses only its explicit grants;
 * non-legacy access is supplied exclusively by the external provider.
 */
export async function resolveVectorixFeatureProvider(
    organizationId: string,
    legacy: boolean,
    legacyFeatureKeys: ReadonlySet<string> = new Set()
): Promise<FeatureProviderResolution> {
    if (legacy) {
        return {
            source: 'manual',
            isEnabled: (key) => legacyFeatureKeys.has(key),
            providers: {
                legacy: { active: true },
                external: {
                    configured: false,
                    reachable: false,
                    expiresAt: null,
                    error: null,
                },
                plan: { active: false, name: null, status: null },
            },
        };
    }

    const external = await getExternalVectorixEntitlements(organizationId);
    // Recheck time for every use, including a cached provider response.
    const valid =
        external.configured &&
        external.reachable &&
        (external.expiresAt === null ||
            Date.parse(external.expiresAt) > Date.now());
    return {
        source: external.configured ? 'external' : 'default',
        isEnabled: (key, externalKey) =>
            valid && external.features[externalKey ?? key] === true,
        providers: {
            legacy: { active: false },
            external: {
                configured: external.configured,
                reachable: external.reachable,
                expiresAt: external.expiresAt,
                error: external.error,
            },
            // Frozen V1 metadata remains, but never describes a local DB plan.
            plan: { active: false, name: null, status: null },
        },
    };
}
