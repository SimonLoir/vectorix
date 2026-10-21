import { authorized } from '@routers/utils/authorized';
import { getMembers } from './private/get-members';
import { getCurrentMember } from './private/get-current-member';
export const adminMembersRouter = authorized
    .prefix('/members')
    .router({ get: getMembers, me: getCurrentMember });
