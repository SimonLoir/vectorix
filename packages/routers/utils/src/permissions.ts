import { ORPCError } from '@orpc/server';
import { permits, type PermissionSet } from '@repo/auth/permissions';
import { operationPermissions } from '@repo/auth/permissions/operations';

export { permits } from '@repo/auth/permissions';
export type { PermissionSet } from '@repo/auth/permissions';

export type PermissionContext = {
    permissions: PermissionSet;
    legacyApiKey: boolean;
};

/** Permission check for a named operation; unclassified names fail closed. */
export function permitsOperation(
    permissions: PermissionSet,
    operation: string
): boolean {
    const required = operationPermissions[operation];
    return Boolean(required && permits(permissions, required));
}

/** Enforces required actions while preserving the frozen set of production keys. */
export function requirePermissions(
    context: PermissionContext,
    required: PermissionSet
) {
    if (!context.legacyApiKey && !permits(context.permissions, required)) {
        throw new ORPCError('FORBIDDEN', {
            message: 'Vous ne disposez pas des permissions nécessaires.',
        });
    }
}

/** Resolves an explicitly classified operation; unknown operations always fail closed. */
export function requireOperationPermissions(
    context: PermissionContext,
    path: readonly string[]
) {
    const required = operationPermissions[path.join('.')];
    if (!required)
        throw new ORPCError('FORBIDDEN', {
            message: 'Unclassified private operation.',
        });
    requirePermissions(context, required);
}
