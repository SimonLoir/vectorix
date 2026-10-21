import {
    APIError,
    createAuthMiddleware,
    getSessionFromCtx,
} from 'better-auth/api';
import { permits } from './access-control';
import { getMemberPermissions } from './resolve';

/** Native organization endpoints must not bypass Vectorix member/invitation read permissions. */
export const organizationReadPolicyHook = createAuthMiddleware(async (ctx) => {
    const resource =
        ctx.path === '/organization/list-members'
            ? 'member'
            : ctx.path === '/organization/list-invitations'
              ? 'invitation'
              : null;
    if (!resource) return;
    const session = await getSessionFromCtx(ctx);
    const organizationId =
        ctx.query?.organizationId ?? session?.session.activeOrganizationId;
    if (!session || !organizationId) throw new APIError('UNAUTHORIZED');
    const access = await getMemberPermissions(organizationId, session.user.id);
    if (!access || !permits(access.permissions, { [resource]: ['read'] }))
        throw new APIError('FORBIDDEN');
});

/** Keeps useActiveOrganization available while removing unauthorized member/invitation projections. */
export const organizationReadResultHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path !== '/organization/get-full-organization') return;
    const returned = ctx.context.returned;
    if (
        !returned ||
        typeof returned !== 'object' ||
        !('id' in returned) ||
        typeof returned.id !== 'string'
    )
        return;
    const session = await getSessionFromCtx(ctx);
    if (!session) return;
    const access = await getMemberPermissions(returned.id, session.user.id);
    if (!access) throw new APIError('FORBIDDEN');
    return ctx.json({
        ...returned,
        ...(permits(access.permissions, { member: ['read'] })
            ? {}
            : {
                  members:
                      'members' in returned && Array.isArray(returned.members)
                          ? returned.members.filter(
                                (member: { userId: string }) =>
                                    member.userId === session.user.id
                            )
                          : [],
              }),
        ...(permits(access.permissions, { invitation: ['read'] })
            ? {}
            : { invitations: [] }),
    });
});
