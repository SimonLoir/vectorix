import { ORPCError } from '@orpc/server';
import { permits, validatePermissions } from '@repo/auth/permissions';
import { assertPermissionsInitialized } from '@repo/auth/permissions/rollout';
import type { AuthorizedContext } from '@routers/utils/authorized';

/** Delegation requires a real member and never grants more than that member currently owns. */
export async function scopedKeyPermissions(
    context: AuthorizedContext,
    value: unknown
) {
    if (!context.user || context.key) throw new ORPCError('FORBIDDEN');
    await assertPermissionsInitialized();
    let permissions;
    try {
        permissions = validatePermissions(value, true);
    } catch (error) {
        throw new ORPCError('BAD_REQUEST', {
            message:
                error instanceof Error ? error.message : 'Invalid permissions',
        });
    }
    if (!permits(context.permissions, permissions))
        throw new ORPCError('FORBIDDEN');
    return permissions;
}
