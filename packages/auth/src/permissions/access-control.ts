import { ragStatements, ragMemberStatements } from './rag';
import {
    createAccessControl,
    role,
    type Statements,
} from 'better-auth/plugins/access';
import {
    adminAc,
    defaultStatements,
    memberAc,
    ownerAc,
} from 'better-auth/plugins/organization/access';
import {
    businessStatements,
    copyPermissions,
    type PermissionSet,
} from './catalogue';

export const statements = {
    ...defaultStatements,
    ...businessStatements,
    ...ragStatements,
    member: ['read', ...defaultStatements.member],
    invitation: ['read', ...defaultStatements.invitation],
    apiKey: ['create', 'read', 'update', 'delete'],
} as const;

export const accessControl = createAccessControl<Statements>(statements);

// Keep the historical built-in roles stable for existing V1 consumers/members.
// Custom roles are stored by Better Auth and start with no selected permissions.
export const roles = {
    owner: accessControl.newRole({
        ...businessStatements,
        ...ownerAc.statements,
        ...ragStatements,
        member: statements.member,
        invitation: statements.invitation,
        apiKey: statements.apiKey,
    }),
    admin: accessControl.newRole({
        ...businessStatements,
        ...adminAc.statements,
        ...ragStatements,
        member: statements.member,
        invitation: statements.invitation,
    }),
    member: accessControl.newRole({
        ...businessStatements,
        ...memberAc.statements,
        ...ragMemberStatements,
        member: ['read'],
        invitation: ['read'],
    }),
};

export { businessStatements, copyPermissions } from './catalogue';

export type { PermissionSet } from './catalogue';

/** Checks AND semantics using Better Auth's access-control primitive. */
export function permits(
    granted: PermissionSet,
    required: PermissionSet
): boolean {
    const nonEmpty = Object.fromEntries(
        Object.entries(required).filter(([, actions]) => actions.length)
    );
    return (
        !Object.keys(nonEmpty).length ||
        role(granted).authorize(nonEmpty).success
    );
}

/** Validates explicit permissions; reserved maintenance access cannot be delegated. */
export function validatePermissions(
    value: unknown,
    apiKey = false
): PermissionSet {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Explicit permissions are required.');
    const result: PermissionSet = {};
    for (const [resource, actions] of Object.entries(value)) {
        const allowed = Object.hasOwn(statements, resource)
            ? statements[resource as keyof typeof statements]
            : undefined;
        if (
            !allowed ||
            resource === 'maintenance' ||
            !Array.isArray(actions) ||
            actions.some(
                (action) =>
                    typeof action !== 'string' ||
                    !(allowed as readonly string[]).includes(action)
            )
        ) {
            throw new Error('Unknown or reserved permission.');
        }
        if (actions.length) result[resource] = [...new Set<string>(actions)];
    }
    if (apiKey) {
        // Keys cannot mint keys, manage members/roles, or acquire every business action.
        const forbidden = [
            'organization',
            'member',
            'invitation',
            'team',
            'ac',
            'apiKey',
            'ragCredentials',
            'ragGroups',
            'ragAudit',
            'ragQuota',
        ];
        const business = Object.fromEntries(
            Object.entries(businessStatements).filter(
                ([key]) => key !== 'maintenance'
            )
        );
        if (
            !Object.keys(result).length ||
            forbidden.some((key) => result[key]?.length) ||
            (result.ragCollection ?? []).some(
                (action) => !['read', 'manageDocuments'].includes(action)
            ) ||
            (result.ragLibrary ?? []).some((action) => action !== 'read') ||
            permits(result, copyPermissions(business))
        ) {
            throw new Error(
                'API keys require a limited business permission set.'
            );
        }
    }
    return result;
}
