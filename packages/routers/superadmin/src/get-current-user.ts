import { superAdminV1 } from './v1-implementer';

export const getCurrentSuperAdmin = superAdminV1.me.handler(
    ({ context: { user } }) => ({ user })
);
