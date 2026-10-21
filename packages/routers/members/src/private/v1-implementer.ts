import { implement } from '@orpc/server';
import { adminMembersV1Contract } from '@repo/api-contracts/v1/members/admin';
import type { AuthorizedContext } from '@routers/utils/authorized';

export const adminMembersV1 = implement(
    adminMembersV1Contract
).$context<AuthorizedContext>();
