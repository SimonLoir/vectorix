import { ragV1 } from '../v1-implementer';
import { changeGrant } from '../services/grants';
export const setGrantHandler = ragV1.collections.setGrant.handler(
    ({ context, input }) => changeGrant(context, input)
);
