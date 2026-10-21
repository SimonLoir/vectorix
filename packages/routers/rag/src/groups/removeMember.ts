import { ragV1 } from '../v1-implementer';
import { changeGroupMember } from '../services/groups';
export const removeMemberGroupHandler = ragV1.groups.removeMember.handler(
    ({ context, input }) => changeGroupMember(context, input, false)
);
