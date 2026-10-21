import { commercialFeatureWhere, isCommercialFeature } from './catalogue';
import { createHash } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';

export const legacyFeatureOverrideSelect = {
    id: true,
    featureId: true,
    enabled: true,
    reason: true,
    expiresAt: true,
    updatedAt: true,
} satisfies Prisma.VectorixOrganizationFeatureOverrideSelect;

type Definition = {
    id: string;
    key: string;
    isActive: boolean;
    updatedAt: Date;
};
type Override = Prisma.VectorixOrganizationFeatureOverrideGetPayload<{
    select: typeof legacyFeatureOverrideSelect;
}>;

/** Includes tenant, mode, catalogue changes and every stored grant, so older single-feature writes also invalidate the snapshot. */
export function legacyFeatureSelectionVersion(
    organizationId: string,
    legacy: boolean,
    definitions: Definition[],
    overrides: Override[]
) {
    const catalogue = definitions
        .map(({ id, key, isActive, updatedAt }) => ({
            id,
            key,
            isActive,
            updatedAt,
        }))
        .toSorted((a, b) => a.id.localeCompare(b.id));
    const grants = overrides
        .map((override) => ({ ...override }))
        .toSorted((a, b) => a.featureId.localeCompare(b.featureId));
    return createHash('sha256')
        .update(JSON.stringify({ organizationId, legacy, catalogue, grants }))
        .digest('hex');
}

/** An explicit grant remains effective only until its own expiry; defaults and provider aliases are irrelevant. */
export function isLegacyFeatureGrantEnabled(
    override: Pick<Override, 'enabled' | 'expiresAt'> | undefined,
    now: number
) {
    return (
        override?.enabled === true &&
        (override.expiresAt === null || override.expiresAt.getTime() > now)
    );
}

/** Reads an organization-specific selection in the transaction used for its replacement. */
export async function readLegacyFeatureSelection(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const [organization, catalogue, overrides] = await Promise.all([
        db.organization.findUnique({
            where: { id: organizationId },
            select: { vectorixLegacyAccess: true },
        }),
        db.vectorixFeatureDefinition.findMany({
            where: commercialFeatureWhere,
            select: { id: true, key: true, isActive: true, updatedAt: true },
        }),
        db.vectorixOrganizationFeatureOverride.findMany({
            where: { organizationId },
            select: legacyFeatureOverrideSelect,
        }),
    ]);
    if (!organization)
        throw new ORPCError('NOT_FOUND', {
            message: 'Organisation introuvable.',
        });
    const definitions = catalogue.filter((feature) =>
        isCommercialFeature(feature.key)
    );
    return {
        organization,
        definitions,
        overrides,
        version: legacyFeatureSelectionVersion(
            organizationId,
            organization.vectorixLegacyAccess,
            definitions,
            overrides
        ),
    };
}
