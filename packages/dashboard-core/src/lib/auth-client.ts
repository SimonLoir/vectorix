import { createAuthClient } from 'better-auth/client';
import {
    inferAdditionalFields,
    organizationClient,
    twoFactorClient,
} from 'better-auth/client/plugins';
import { passkeyClient } from '@better-auth/passkey/client';
import { apiKeyClient } from '@better-auth/api-key/client';
import { statements, roles } from '@repo/auth/permissions';
import { userLocaleFields } from '@repo/auth/user-locale-fields';
import {
    createAccessControl,
    type Statements,
    type Role,
} from 'better-auth/plugins/access';

// Instantiate with this package's Better Auth types: pnpm may install separate peer contexts.
const clientAccessControl = createAccessControl<Statements>(statements);
const clientRoles: Record<string, Role> = {
    owner: clientAccessControl.newRole(roles.owner.statements),
    admin: clientAccessControl.newRole(roles.admin.statements),
    member: clientAccessControl.newRole(roles.member.statements),
};

export const authClientPlugins = [
    inferAdditionalFields({ user: userLocaleFields }),
    organizationClient({
        ac: clientAccessControl,
        roles: clientRoles,
        dynamicAccessControl: { enabled: true as const },
    }),
    passkeyClient(),
    // Sign-in forms handle `twoFactorRedirect` themselves (no page redirect).
    twoFactorClient(),
    apiKeyClient(),
];

export const getAuthClient = (baseURL: string) => {
    return createAuthClient({
        baseURL,
        plugins: authClientPlugins,
    });
};

export const authClient = getAuthClient(
    process.env.API_URL ?? 'http://localhost:3001'
);
