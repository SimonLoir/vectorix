import { ragV1 } from '../v1-implementer';
import { createGroup } from '../services/groups';
export const createGroupHandler = ragV1.groups.create.handler(
    ({ context, input }) => createGroup(context, input.name)
);
