import { superAdminV1 } from './v1-implementer';

export const getSuperAdminDashboard = superAdminV1.dashboard.handler(
    async ({ context: { db } }) => {
        const [
            organizationsTotal,
            activeOrganizations,
            usersTotal,
            featuresTotal,
            paywalledFeaturesTotal,
            manualOverridesTotal,
        ] = await Promise.all([
            db.organization.count(),
            db.organization.count({ where: { isActive: true } }),
            db.user.count(),
            db.vectorixFeatureDefinition.count({ where: { isActive: true } }),
            db.vectorixFeatureDefinition.count({
                where: { isActive: true, isPaywalled: true },
            }),
            db.vectorixOrganizationFeatureOverride.count({
                where: {
                    OR: [
                        { expiresAt: null },
                        { expiresAt: { gt: new Date() } },
                    ],
                },
            }),
        ]);

        return {
            organizationsTotal,
            activeOrganizations,
            usersTotal,
            featuresTotal,
            paywalledFeaturesTotal,
            manualOverridesTotal,
            externalProviderConfigured: Boolean(
                process.env.VECTORIX_FEATURE_PROVIDER_URL?.trim()
            ),
        };
    }
);
