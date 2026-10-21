import { implement } from '@orpc/server';
import { superAdminV1Contract } from '@repo/api-contracts/v1/superadmin/index';
import type { SuperAdminContext } from '@routers/utils/super-admin';

export const superAdminV1 =
    implement(superAdminV1Contract).$context<SuperAdminContext>();
