import { implement } from '@orpc/server';
import { adminNotificationsV1Contract } from '@repo/api-contracts/v1/notifications';
import type { AuthorizedContext } from '@routers/utils/authorized';

export const adminNotificationsV1 = implement(
    adminNotificationsV1Contract
).$context<AuthorizedContext>();
