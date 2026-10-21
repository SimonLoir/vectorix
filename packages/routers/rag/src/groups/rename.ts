import { ragV1 } from '../v1-implementer';
import { renameGroup } from '../services/groups';
export const renameGroupHandler = ragV1.groups.rename.handler(
    ({ context, input }) => renameGroup(context, input)
);
