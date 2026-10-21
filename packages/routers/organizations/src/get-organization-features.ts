import { resolveVectorixFeatures } from '@routers/utils/vectorix-features';
import { adminOrganizationsV1 } from './v1-implementer';
export const getOrganizationFeatures = adminOrganizationsV1.features.handler(
    ({ context }) => resolveVectorixFeatures(context.db, context.organizationId)
);
