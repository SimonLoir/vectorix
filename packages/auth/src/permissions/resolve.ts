import { prisma } from '@repo/db';
import { copyPermissions, roles, type PermissionSet } from './access-control';

/** Resolves current role definitions per request; revocation never depends on session claims. */
export async function getOrganizationRoles(organizationId: string) {
    const dynamic = await prisma.organizationRole.findMany({
        where: { organizationId },
    });
    return [
        ...Object.entries(roles).map(([role, definition]) => ({
            role,
            permissions: copyPermissions(definition.statements),
            builtIn: true,
        })),
        ...dynamic
            .filter(({ role }) => !Object.hasOwn(roles, role))
            .map(({ role, permission }) => ({
                role,
                permissions: JSON.parse(permission) as PermissionSet,
                builtIn: false,
            })),
    ];
}

/** Better Auth stores multiple role names as comma-separated strings. Unknown roles grant nothing. */
export function resolvePermissions(
    role: string,
    definitions: { role: string; permissions: PermissionSet }[]
): PermissionSet {
    const names = new Set(role.split(',').map((name) => name.trim()));
    const result: PermissionSet = {};
    for (const definition of definitions) {
        if (!names.has(definition.role)) continue;
        for (const [resource, actions] of Object.entries(
            definition.permissions
        )) {
            result[resource] = [
                ...new Set([...(result[resource] ?? []), ...actions]),
            ];
        }
    }
    return result;
}

/** Reads membership from the database, including after a session's membership has been removed. */
export async function getMemberPermissions(
    organizationId: string,
    userId: string
) {
    const member = await prisma.member.findFirst({
        where: { organizationId, userId },
    });
    if (!member) return null;
    const definitions = await getOrganizationRoles(organizationId);
    return {
        member,
        definitions,
        permissions: resolvePermissions(member.role, definitions),
    };
}
