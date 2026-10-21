import { ragV1 } from '../v1-implementer';
import { changeGroupMember } from '../services/groups';
export const addMemberGroupHandler = ragV1.groups.addMember.handler(
    ({ context, input }) => changeGroupMember(context, input, true)
);
