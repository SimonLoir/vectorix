import { oc } from '@orpc/contract';
import { setRagQuotaContract, getRagQuotaContract } from './rag-quota';
import { z } from 'zod';
import { setOrganizationLegacyAccessV1Contract } from './legacy-access';
import { superAdminUsersV1Contract } from './users';
import { setLegacyFeaturesV1Contract } from './legacy-features';

const featureKeyV1Schema = z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z][a-z0-9.-]*$/);

const featureDefinitionV1Schema = z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    category: z.string(),
    defaultEnabled: z.boolean(),
    isPaywalled: z.boolean(),
    isActive: z.boolean(),
    externalKey: z.string().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
});

const organizationSummaryV1Schema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable(),
    isActive: z.boolean(),
    vectorixLegacyAccess: z.boolean().optional(),
    createdAt: z.date(),
    _count: z.object({
        members: z.number().int(),
        vectorixFeatureOverrides: z.number().int(),
    }),
});

const organizationMemberV1Schema = z.object({
    id: z.string(),
    role: z.string(),
    createdAt: z.date(),
    user: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        image: z.string().nullable(),
        emailVerified: z.boolean(),
    }),
});

const organizationV1Schema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    logo: z.string().nullable(),
    isActive: z.boolean(),
    vectorixLegacyAccess: z.boolean().optional(),
    metadata: z.string().nullable(),
    createdAt: z.date(),
    members: z.array(organizationMemberV1Schema),
    _count: z.object({
        vectorixFeatureOverrides: z.number().int(),
    }),
});

const organizationUpdateOutputV1Schema = organizationV1Schema.pick({
    id: true,
    name: true,
    slug: true,
    logo: true,
    isActive: true,
    vectorixLegacyAccess: true,
    metadata: true,
    createdAt: true,
});

const featureOverrideV1Schema = z.object({
    id: z.string(),
    organizationId: z.string(),
    featureId: z.string(),
    enabled: z.boolean(),
    reason: z.string().nullable(),
    expiresAt: z.date().nullable(),
    createdAt: z.date(),
    updatedAt: z.date(),
});

const organizationIdV1Schema = z.object({ organizationId: z.string().min(1) });
const organizationMemberInputV1Schema = organizationIdV1Schema.extend({
    memberId: z.string().min(1),
});
const superAdminAuditLogV1Schema = z.object({
    id: z.string(),
    action: z.string(),
    targetId: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
    ipAddress: z.string().nullable(),
    createdAt: z.date(),
    user: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
    }),
    organization: z
        .object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
        })
        .nullable(),
});
const organizationFeatureInputV1Schema = organizationIdV1Schema.extend({
    featureId: z.string().min(1),
});

const featureDefinitionCreateInputV1Schema = z.object({
    key: featureKeyV1Schema,
    name: z.string().trim().min(1).max(150),
    description: z.string().trim().max(1000).nullable().optional(),
    category: z.string().trim().min(1).max(100).default('general'),
    defaultEnabled: z.boolean().default(true),
    isPaywalled: z.boolean().default(false),
    isActive: z.boolean().default(true),
    externalKey: z.string().trim().max(150).nullable().optional(),
});

const featureDefinitionUpdateInputV1Schema = z.object({
    featureId: z.string().min(1),
    key: featureKeyV1Schema.optional(),
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    category: z.string().trim().min(1).max(100).optional(),
    defaultEnabled: z.boolean().optional(),
    isPaywalled: z.boolean().optional(),
    isActive: z.boolean().optional(),
    externalKey: z.string().trim().max(150).nullable().optional(),
});

export const entitlementsV1Schema = z.object({
    legacyFeatureVersion: z.string().nullable().optional(),
    features: z.array(
        featureDefinitionV1Schema
            .omit({ createdAt: true, updatedAt: true })
            .extend({
                enabled: z.boolean(),
                source: z.enum(['default', 'plan', 'external', 'manual']),
                override: z
                    .object({
                        id: z.string(),
                        enabled: z.boolean(),
                        reason: z.string().nullable(),
                        expiresAt: z.date().nullable(),
                    })
                    .nullable(),
            })
    ),
    providers: z.object({
        legacy: z.object({ active: z.boolean() }).optional(),
        external: z.object({
            configured: z.boolean(),
            reachable: z.boolean(),
            expiresAt: z.string().nullable(),
            error: z.string().nullable(),
        }),
        plan: z.object({
            active: z.boolean(),
            name: z.string().nullable(),
            status: z.string().nullable(),
        }),
    }),
});

export const superAdminV1Contract = {
    users: superAdminUsersV1Contract,
    me: oc
        .route({ method: 'GET', path: '/me' })
        .input(z.object({}).strict().default({}))
        .output(
            z.object({
                user: z.object({
                    id: z.string(),
                    name: z.string(),
                    email: z.string(),
                    image: z.string().nullable(),
                    isSuperAdmin: z.literal(true),
                }),
            })
        ),
    dashboard: oc
        .route({ method: 'GET', path: '/dashboard' })
        .input(z.object({}).strict().default({}))
        .output(
            z.object({
                organizationsTotal: z.number().int(),
                activeOrganizations: z.number().int(),
                usersTotal: z.number().int(),
                featuresTotal: z.number().int(),
                paywalledFeaturesTotal: z.number().int(),
                manualOverridesTotal: z.number().int(),
                externalProviderConfigured: z.boolean(),
            })
        ),
    audit: {
        list: oc
            .route({ method: 'GET', path: '/audit' })
            .input(
                z
                    .object({
                        page: z.number().int().min(1).default(1),
                        limit: z.number().int().min(1).max(100).default(25),
                        search: z.string().trim().max(200).optional(),
                        action: z.string().trim().max(200).optional(),
                    })
                    .prefault({})
            )
            .output(
                z.object({
                    logs: z.array(superAdminAuditLogV1Schema),
                    total: z.number().int(),
                    actions: z.array(z.string()),
                })
            ),
    },
    organizations: {
        setRagQuota: setRagQuotaContract,
        getRagQuota: getRagQuotaContract,
        setLegacyAccess: setOrganizationLegacyAccessV1Contract,
        setLegacyFeatures: setLegacyFeaturesV1Contract,
        create: oc
            .route({ method: 'POST', path: '/' })
            .input(
                z.object({
                    name: z.string().trim().min(1).max(200),
                    slug: z
                        .string()
                        .trim()
                        .min(2)
                        .max(100)
                        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
                    isActive: z.boolean().default(true),
                })
            )
            .output(organizationUpdateOutputV1Schema),
        list: oc
            .route({ method: 'GET', path: '/' })
            .input(
                z
                    .object({
                        page: z.number().int().min(1).default(1),
                        limit: z.number().int().min(1).max(100).default(25),
                        search: z.string().trim().max(200).optional(),
                        status: z.enum(['active', 'inactive']).optional(),
                    })
                    .prefault({})
            )
            .output(
                z.object({
                    organizations: z.array(organizationSummaryV1Schema),
                    total: z.number().int(),
                })
            ),
        get: oc
            .route({ method: 'GET', path: '/{organizationId}' })
            .input(organizationIdV1Schema)
            .output(organizationV1Schema),
        update: oc
            .route({ method: 'PUT', path: '/{organizationId}' })
            .input(
                organizationIdV1Schema.extend({
                    name: z.string().trim().min(1).max(200).optional(),
                    slug: z.string().trim().min(1).max(100).optional(),
                    logo: z.string().nullable().optional(),
                    isActive: z.boolean().optional(),
                    metadata: z.string().nullable().optional(),
                })
            )
            .output(organizationUpdateOutputV1Schema),
        members: {
            add: oc
                .route({
                    method: 'POST',
                    path: '/{organizationId}/members',
                })
                .input(
                    organizationIdV1Schema.extend({
                        email: z.email().trim().max(320),
                        role: z.enum(['owner', 'admin', 'member']),
                        name: z.string().trim().min(1).max(200).optional(),
                        password: z.string().min(8).max(128).optional(),
                        emailVerified: z.boolean().default(false),
                    })
                )
                .output(
                    z.object({
                        member: organizationMemberV1Schema,
                        userCreated: z.boolean(),
                    })
                ),
            updateRole: oc
                .route({
                    method: 'PUT',
                    path: '/{organizationId}/members/{memberId}',
                })
                .input(
                    organizationMemberInputV1Schema.extend({
                        role: z.enum(['owner', 'admin', 'member']),
                    })
                )
                .output(organizationMemberV1Schema),
            remove: oc
                .route({
                    method: 'DELETE',
                    path: '/{organizationId}/members/{memberId}',
                })
                .input(organizationMemberInputV1Schema)
                .output(z.object({ success: z.literal(true) })),
        },
        features: oc
            .route({ method: 'GET', path: '/{organizationId}/features' })
            .input(organizationIdV1Schema)
            .output(entitlementsV1Schema),
        setFeatureOverride: oc
            .route({
                method: 'PUT',
                path: '/{organizationId}/features/{featureId}',
            })
            .input(
                organizationFeatureInputV1Schema.extend({
                    enabled: z.boolean(),
                    reason: z.string().nullable().optional(),
                    expiresAt: z.date().nullable().optional(),
                })
            )
            .output(featureOverrideV1Schema),
        clearFeatureOverride: oc
            .route({
                method: 'DELETE',
                path: '/{organizationId}/features/{featureId}',
            })
            .input(organizationFeatureInputV1Schema)
            .output(z.object({ success: z.literal(true) })),
    },
    features: {
        list: oc
            .route({ method: 'GET', path: '/' })
            .input(z.object({}).strict().default({}))
            .output(
                z.object({
                    features: z.array(
                        featureDefinitionV1Schema.extend({
                            _count: z.object({
                                organizationOverrides: z.number().int(),
                            }),
                        })
                    ),
                })
            ),
        create: oc
            .route({ method: 'POST', path: '/' })
            .input(featureDefinitionCreateInputV1Schema)
            .output(featureDefinitionV1Schema),
        update: oc
            .route({ method: 'PUT', path: '/{featureId}' })
            .input(featureDefinitionUpdateInputV1Schema)
            .output(featureDefinitionV1Schema),
    },
};
