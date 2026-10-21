import { implement } from '@orpc/server';
import { v1Contract } from '@repo/api-contracts/v1';
import type { ApiContext } from '@routers/utils/base';
import { authorized } from '@routers/utils/authorized';
import { organizationRouter } from '@routers/organizations';
import { adminMembersRouter } from '@routers/members';
import { notificationsRouter } from '@routers/notifications';
import { superAdminRouter } from '@routers/superadmin';
import { systemV1Router } from './v1/system';
export type {
    VectorixApiV1Client,
    VectorixApiV1Contract,
    VectorixApiV1Outputs,
} from '@repo/api-contracts/v1';
export const router = implement(v1Contract)
    .$context<ApiContext>()
    .router({
        ...systemV1Router,
        superadmin: superAdminRouter,
        admin: authorized.prefix('/admin').router({
            organization: organizationRouter,
            members: adminMembersRouter,
            notifications: notificationsRouter,
        }),
    });
