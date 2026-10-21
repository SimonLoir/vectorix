import { ragV1 } from '../v1-implementer';
import { deleteGroup } from '../services/groups';
export const deleteGroupHandler = ragV1.groups.delete.handler(
    ({ context, input }) => deleteGroup(context, input.id)
);
