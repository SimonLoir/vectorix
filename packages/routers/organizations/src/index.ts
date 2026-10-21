import { authorized } from '@routers/utils/authorized';
import { getOrganization } from './get-organization';
import { getOrganizationAccess } from './get-organization-access';
import { getOrganizationFeatures } from './get-organization-features';
import { createScopedApiKey } from './api-keys/create-api-key';
import { listScopedApiKeys } from './api-keys/list-api-keys';
import { updateScopedApiKeyPermissions } from './api-keys/update-api-key-permissions';
export const organizationRouter = authorized.prefix('/organization').router({
    get: getOrganization,
    access: getOrganizationAccess,
    features: getOrganizationFeatures,
    apiKeys: {
        list: listScopedApiKeys,
        create: createScopedApiKey,
        updatePermissions: updateScopedApiKeyPermissions,
    },
});
