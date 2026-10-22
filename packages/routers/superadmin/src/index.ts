import { setRagQuota } from './set-rag-quota';
import { getRagQuota } from './get-rag-quota';
import { getSemanticQuota } from './get-semantic-quota';
import { setSemanticQuota } from './set-semantic-quota';
import { getOperations } from './get-operations';
import { superAdmin } from '@routers/utils/super-admin';
import { getCurrentSuperAdmin } from './get-current-user';
import { getSuperAdminDashboard } from './get-dashboard';
import { listOrganizations } from './list-organizations';
import { getOrganization } from './get-organization';
import { updateOrganization } from './update-organization';
import { getOrganizationEntitlements } from './get-organization-entitlements';
import { setOrganizationFeatureOverride } from './set-organization-feature-override';
import { clearOrganizationFeatureOverride } from './clear-organization-feature-override';
import { listFeatureDefinitions } from './list-feature-definitions';
import { createFeatureDefinition } from './create-feature-definition';
import { updateFeatureDefinition } from './update-feature-definition';
import { createOrganization } from './create-organization';
import { addOrganizationMember } from './add-organization-member';
import { updateOrganizationMemberRole } from './update-organization-member-role';
import { removeOrganizationMember } from './remove-organization-member';
import { listSuperAdminAuditLogs } from './list-superadmin-audit-logs';
import { setOrganizationLegacyAccess } from './set-organization-legacy-access';
import { listSuperAdminUsers } from './list-users';
import { getSuperAdminUser } from './get-user';
import { setUserSuperAdmin } from './set-user-superadmin';
import { setOrganizationLegacyFeatures } from './set-organization-legacy-features';

export const superAdminRouter = superAdmin
    .prefix('/superadmin')
    .tag('Administration')
    .router({
        me: getCurrentSuperAdmin,
        users: superAdmin.prefix('/users').router({
            list: listSuperAdminUsers,
            get: getSuperAdminUser,
            setSuperAdmin: setUserSuperAdmin,
        }),
        dashboard: getSuperAdminDashboard,
        audit: superAdmin.router({ list: listSuperAdminAuditLogs }),
        organizations: superAdmin.prefix('/organizations').router({
            getOperations,
            setRagQuota,
            getRagQuota,
            getSemanticQuota,
            setSemanticQuota,
            create: createOrganization,
            list: listOrganizations,
            get: getOrganization,
            update: updateOrganization,
            setLegacyAccess: setOrganizationLegacyAccess,
            setLegacyFeatures: setOrganizationLegacyFeatures,
            members: superAdmin.router({
                add: addOrganizationMember,
                updateRole: updateOrganizationMemberRole,
                remove: removeOrganizationMember,
            }),
            features: getOrganizationEntitlements,
            setFeatureOverride: setOrganizationFeatureOverride,
            clearFeatureOverride: clearOrganizationFeatureOverride,
        }),
        features: superAdmin.prefix('/features').router({
            list: listFeatureDefinitions,
            create: createFeatureDefinition,
            update: updateFeatureDefinition,
        }),
    });
