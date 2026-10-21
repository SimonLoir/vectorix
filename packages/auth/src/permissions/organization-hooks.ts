import {
    APIError,
    createAuthMiddleware,
    getSessionFromCtx,
} from 'better-auth/api';
import { prisma } from '@repo/db';
import {
    permits,
    validatePermissions,
    type PermissionSet,
} from './access-control';
import { getMemberPermissions, resolvePermissions } from './resolve';

const rolePaths = new Set([
    '/organization/create-role',
    '/organization/update-role',
    '/organization/delete-role',
]);
const assignmentPaths = new Set([
    '/organization/update-member-role',
    '/organization/invite-member',
]);

/** Adds delegation boundaries to Better Auth's native member/role endpoints. */
export const organizationPolicyHook = createAuthMiddleware(async (ctx) => {
    if (
        !ctx.path ||
        (!rolePaths.has(ctx.path) &&
            !assignmentPaths.has(ctx.path) &&
            ctx.path !== '/organization/remove-member')
    )
        return;
    const session = await getSessionFromCtx(ctx);
    const organizationId =
        ctx.body?.organizationId ?? session?.session.activeOrganizationId;
    if (!session || typeof organizationId !== 'string')
        throw new APIError('UNAUTHORIZED');
    const actor = await getMemberPermissions(organizationId, session.user.id);
    if (!actor) throw new APIError('FORBIDDEN');

    if (
        ctx.path === '/organization/update-member-role' ||
        ctx.path === '/organization/remove-member'
    ) {
        const identifier = ctx.body.memberId ?? ctx.body.memberIdOrEmail;
        const target =
            typeof identifier === 'string'
                ? await prisma.member.findFirst({
                      where: {
                          organizationId,
                          ...(identifier.includes('@')
                              ? { user: { email: identifier } }
                              : { id: identifier }),
                      },
                  })
                : null;
        if (!target) throw new APIError('NOT_FOUND');
        if (
            !permits(
                actor.permissions,
                resolvePermissions(target.role, actor.definitions)
            )
        )
            throw new APIError('FORBIDDEN', {
                message: 'Cannot manage a member above your own permissions.',
            });
        if (ctx.path === '/organization/remove-member') return;
    }

    if (assignmentPaths.has(ctx.path)) {
        const names = (
            Array.isArray(ctx.body.role)
                ? ctx.body.role
                : String(ctx.body.role).split(',')
        ).map((name: string) => name.trim());
        if (
            !names.length ||
            names.some(
                (name: string) =>
                    !actor.definitions.some(
                        (definition) => definition.role === name
                    )
            )
        )
            throw new APIError('BAD_REQUEST', { message: 'Unknown role.' });
        const required = resolvePermissions(names.join(','), actor.definitions);
        if (!permits(actor.permissions, required))
            throw new APIError('FORBIDDEN', {
                message:
                    'Cannot assign a role with permissions you do not have.',
            });
        return;
    }

    if (ctx.path !== '/organization/create-role') {
        const existing = await prisma.organizationRole.findFirst({
            where: {
                organizationId,
                ...(ctx.body.roleId
                    ? { id: ctx.body.roleId }
                    : { role: ctx.body.roleName }),
            },
        });
        if (!existing) throw new APIError('NOT_FOUND');
        if (
            !permits(
                actor.permissions,
                JSON.parse(existing.permission) as PermissionSet
            )
        )
            throw new APIError('FORBIDDEN', {
                message: 'Cannot edit a role above your own permissions.',
            });
        if (ctx.path === '/organization/delete-role') {
            const [members, invitations] = await Promise.all([
                prisma.member.findMany({
                    where: { organizationId },
                    select: { role: true },
                }),
                prisma.invitation.findMany({
                    where: {
                        organizationId,
                        status: 'pending',
                        expiresAt: { gt: new Date() },
                    },
                    select: { role: true },
                }),
            ]);
            if (
                [...members, ...invitations].some(({ role }) =>
                    role
                        ?.split(',')
                        .map((name) => name.trim())
                        .includes(existing.role)
                )
            )
                throw new APIError('BAD_REQUEST', {
                    message:
                        'Reassign members and pending invitations before deleting this role.',
                });
        }
    }
    const roleName =
        ctx.path === '/organization/create-role'
            ? ctx.body.role
            : ctx.body.data?.role;
    if (
        roleName !== undefined &&
        (typeof roleName !== 'string' ||
            !/^[a-z][a-z0-9_-]{1,63}$/.test(roleName))
    )
        throw new APIError('BAD_REQUEST', {
            message:
                'Use 2–64 lowercase letters, digits, underscores or hyphens for the role name.',
        });
    // Renaming would orphan Better Auth's comma-separated membership references.
    if (ctx.path === '/organization/update-role' && roleName !== undefined)
        throw new APIError('BAD_REQUEST', {
            message:
                'Role identifiers cannot be renamed. Create a new role and reassign members.',
        });
    const value =
        ctx.path === '/organization/create-role'
            ? ctx.body.permission
            : ctx.body.data?.permission;
    if (value !== undefined) {
        let permissions;
        try {
            permissions = validatePermissions(value);
        } catch {
            throw new APIError('BAD_REQUEST', {
                message: 'Invalid permissions.',
            });
        }
        if (!permits(actor.permissions, permissions))
            throw new APIError('FORBIDDEN', {
                message: 'Cannot grant permissions you do not have.',
            });
    }
});
