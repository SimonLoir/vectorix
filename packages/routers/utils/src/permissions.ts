import { ORPCError } from '@orpc/server';
import { permits, type PermissionSet } from '@repo/auth/permissions';
import { operationPermissions } from '@repo/auth/permissions/operations';

export { permits } from '@repo/auth/permissions';
export type { PermissionSet } from '@repo/auth/permissions';

export const AUTHORIZATION_DENIED_MESSAGE =
    'You do not have the required permissions.';

export type PermissionContext = {
    permissions: PermissionSet;
    legacyApiKey: boolean;
};

/** Permission check for a named operation; unclassified names fail closed. */
export function permitsOperation(
    permissions: PermissionSet,
    operation: string
): boolean {
    const required = Object.hasOwn(operationPermissions, operation)
        ? operationPermissions[operation]
        : undefined;
    return Boolean(required && permits(permissions, required));
}

/** Enforces required actions while preserving the frozen set of production keys. */
export function requirePermissions(
    context: PermissionContext,
    required: PermissionSet
) {
    if (!context.legacyApiKey && !permits(context.permissions, required)) {
        throw new ORPCError('FORBIDDEN', {
            message: AUTHORIZATION_DENIED_MESSAGE,
        });
    }
}

/** Resolves an explicitly classified operation; unknown operations always fail closed. */
export function requireOperationPermissions(
    context: PermissionContext,
    path: readonly string[]
) {
    const operation = path.join('.');
    const required = Object.hasOwn(operationPermissions, operation)
        ? operationPermissions[operation]
        : undefined;
    if (!required)
        throw new ORPCError('FORBIDDEN', {
            message: AUTHORIZATION_DENIED_MESSAGE,
        });
    requirePermissions(context, required);
}
