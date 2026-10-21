import { ragV1 } from '../v1-implementer';
import { changeGrant } from '../services/grants';
export const removeGrantHandler = ragV1.collections.removeGrant.handler(
    ({ context, input }) => changeGrant(context, input)
);
