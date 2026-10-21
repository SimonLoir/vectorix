import { implement } from '@orpc/server';
import { adminOrganizationsV1Contract } from '@repo/api-contracts/v1/organizations/admin';
import type { AuthorizedContext } from '@routers/utils/authorized';

export const adminOrganizationsV1 = implement(
    adminOrganizationsV1Contract
).$context<AuthorizedContext>();
