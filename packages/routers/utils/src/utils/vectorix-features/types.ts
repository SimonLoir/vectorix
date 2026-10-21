export type VectorixFeatureSource = 'default' | 'plan' | 'external' | 'manual';

export interface ResolvedVectorixFeature {
    id: string;
    key: string;
    name: string;
    description: string | null;
    category: string;
    enabled: boolean;
    source: VectorixFeatureSource;
    defaultEnabled: boolean;
    isPaywalled: boolean;
    isActive: boolean;
    externalKey: string | null;
    override: {
        id: string;
        enabled: boolean;
        reason: string | null;
        expiresAt: Date | null;
    } | null;
}

export interface ExternalVectorixEntitlementsResult {
    configured: boolean;
    reachable: boolean;
    features: Record<string, boolean>;
    expiresAt: string | null;
    error: string | null;
}

export interface ResolvedVectorixFeatures {
    legacyFeatureVersion?: string | null;
    features: ResolvedVectorixFeature[];
    providers: {
        legacy: { active: boolean };
        external: Omit<ExternalVectorixEntitlementsResult, 'features'>;
        plan: {
            active: boolean;
            name: string | null;
            status: string | null;
        };
    };
}
