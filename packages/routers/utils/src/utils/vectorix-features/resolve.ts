import { commercialFeatureWhere, isCommercialFeature } from './catalogue';
import { ORPCError } from '@orpc/server';
import type { PrismaClient } from '@repo/db';
import { resolveVectorixFeatureProvider } from './resolve-provider';
import type { ResolvedVectorixFeatures } from './types';
import {
    isLegacyFeatureGrantEnabled,
    legacyFeatureOverrideSelect,
    legacyFeatureSelectionVersion,
} from './legacy-selection';

/**
 * Vectorix rights come only from the configured external provider, except for
 * explicitly marked legacy organizations, which use their selected feature grants.
 * Local plans and catalogue defaults never grant access. Legacy is checked before
 * reading provider configuration or calling HTTP, keeping it independent of billing.
 * Inactive/unknown definitions still cannot unlock guarded application modules.
 */
export async function resolveVectorixFeatures(
    db: PrismaClient,
    organizationId: string,
    options: { includeInactive?: boolean } = {}
): Promise<ResolvedVectorixFeatures> {
    const [organization, catalogue] = await Promise.all([
        db.organization.findUnique({
            where: { id: organizationId },
            select: { vectorixLegacyAccess: true },
        }),
        db.vectorixFeatureDefinition.findMany({
            where: {
                ...commercialFeatureWhere,
                ...(options.includeInactive ? {} : { isActive: true }),
            },
            orderBy: [{ category: 'asc' }, { name: 'asc' }],
        }),
    ]);
    if (!organization) {
        throw new ORPCError('NOT_FOUND', { message: 'Organization not found' });
    }

    const definitions = catalogue.filter((feature) =>
        isCommercialFeature(feature.key)
    );
    const overrides = organization.vectorixLegacyAccess
        ? await db.vectorixOrganizationFeatureOverride.findMany({
              where: { organizationId },
              select: legacyFeatureOverrideSelect,
          })
        : [];
    const byFeature = new Map(
        overrides.map((override) => [override.featureId, override])
    );
    const now = Date.now();
    const legacyKeys = new Set(
        definitions
            .filter((definition) =>
                isLegacyFeatureGrantEnabled(byFeature.get(definition.id), now)
            )
            .map((definition) => definition.key)
    );
    const provider = await resolveVectorixFeatureProvider(
        organizationId,
        organization.vectorixLegacyAccess,
        legacyKeys
    );
    return {
        legacyFeatureVersion: organization.vectorixLegacyAccess
            ? legacyFeatureSelectionVersion(
                  organizationId,
                  true,
                  definitions,
                  overrides
              )
            : null,
        features: definitions.map((definition) => ({
            id: definition.id,
            key: definition.key,
            name: definition.name,
            description: definition.description,
            category: definition.category,
            enabled:
                definition.isActive &&
                (definition.externalKey === null ||
                    isCommercialFeature(definition.externalKey)) &&
                provider.isEnabled(definition.key, definition.externalKey),
            source: provider.source,
            defaultEnabled: definition.defaultEnabled,
            isPaywalled: definition.isPaywalled,
            isActive: definition.isActive,
            externalKey: definition.externalKey,
            override: byFeature.has(definition.id)
                ? {
                      id: byFeature.get(definition.id)!.id,
                      enabled: byFeature.get(definition.id)!.enabled,
                      reason: byFeature.get(definition.id)!.reason,
                      expiresAt: byFeature.get(definition.id)!.expiresAt,
                  }
                : null,
        })),
        providers: provider.providers,
    };
}

/** Returns whether one active Vectorix feature is enabled for an organization. */
export async function isVectorixFeatureEnabled(
    db: PrismaClient,
    organizationId: string,
    featureKey: string
) {
    const result = await resolveVectorixFeatures(db, organizationId);
    return result.features.some(
        (feature) => feature.key === featureKey && feature.enabled
    );
}

/** Reads one authoritative snapshot for mixed-domain projections without enabling sibling modules. */
export async function getEnabledVectorixFeatureKeys(
    db: PrismaClient,
    organizationId: string
): Promise<Set<string>> {
    const result = await resolveVectorixFeatures(db, organizationId);
    return new Set(
        result.features
            .filter((feature) => feature.enabled)
            .map((feature) => feature.key)
    );
}

/** Requires at least one explicitly enabled module; an empty requirement never grants access. */
export async function assertAnyVectorixFeaturesEnabled(
    db: PrismaClient,
    organizationId: string,
    featureKeys: readonly string[]
) {
    const enabled = await getEnabledVectorixFeatureKeys(db, organizationId);
    if (!featureKeys.some((key) => enabled.has(key))) {
        throw new ORPCError('FORBIDDEN', {
            message:
                'None of the required Vectorix features is enabled for this organization',
        });
    }
}

/** Returns whether every requested active feature is enabled from one provider snapshot. */
export async function areVectorixFeaturesEnabled(
    db: PrismaClient,
    organizationId: string,
    featureKeys: readonly string[]
) {
    const required = new Set(featureKeys);
    if (required.size === 0) return true;
    const result = await resolveVectorixFeatures(db, organizationId);
    const enabled = new Set(
        result.features
            .filter((feature) => feature.enabled)
            .map((feature) => feature.key)
    );
    return [...required].every((featureKey) => enabled.has(featureKey));
}

/** Rejects a request when an organization cannot use a Vectorix feature. */
export async function assertVectorixFeatureEnabled(
    db: PrismaClient,
    organizationId: string,
    featureKey: string
) {
    const enabled = await isVectorixFeatureEnabled(
        db,
        organizationId,
        featureKey
    );

    if (!enabled) {
        throw new ORPCError('FORBIDDEN', {
            message: `The Vectorix feature "${featureKey}" is not enabled for this organization`,
        });
    }
}

/** Rejects unless every dependency and requested feature is enabled. */
export async function assertVectorixFeaturesEnabled(
    db: PrismaClient,
    organizationId: string,
    featureKeys: readonly string[]
) {
    const enabled = await areVectorixFeaturesEnabled(
        db,
        organizationId,
        featureKeys
    );

    if (!enabled) {
        throw new ORPCError('FORBIDDEN', {
            message:
                'The required Vectorix features are not enabled for this organization',
        });
    }
}
