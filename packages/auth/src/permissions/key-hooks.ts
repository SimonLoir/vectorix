import { APIError, createAuthMiddleware } from 'better-auth/api';
import { prisma } from '@repo/db';
import { permits, validatePermissions } from './access-control';
import { getMemberPermissions } from './resolve';
import { assertPermissionsInitialized } from './rollout';

/** Enforces issuance policy even when callers bypass the Vectorix dashboard. */
export const apiKeyPolicyHook = createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/api-key/create') {
        await assertPermissionsInitialized();
        let permissions;
        try {
            permissions = validatePermissions(ctx.body?.permissions, true);
        } catch (error) {
            throw new APIError('BAD_REQUEST', {
                message:
                    error instanceof Error
                        ? error.message
                        : 'Invalid permissions',
            });
        }
        // Scoped issuance is server-only in the native plugin. Never trust an HTTP userId.
        if (
            ctx.request ||
            ctx.headers ||
            ctx.body?.configId !== 'org' ||
            !ctx.body?.organizationId ||
            !ctx.body?.userId
        ) {
            throw new APIError('FORBIDDEN', {
                message: 'Use the Vectorix scoped API-key endpoint.',
            });
        }
        const actor = await getMemberPermissions(
            ctx.body.organizationId,
            ctx.body.userId
        );
        if (
            !actor ||
            !permits(actor.permissions, { apiKey: ['create'] }) ||
            !permits(actor.permissions, permissions)
        ) {
            throw new APIError('FORBIDDEN', {
                message: 'Cannot grant permissions you do not have.',
            });
        }
    }
    if (ctx.path === '/api-key/update' && ctx.body?.permissions !== undefined) {
        // Our scoped endpoint updates permissions and drops legacy status atomically.
        throw new APIError('FORBIDDEN', {
            message:
                'Use the Vectorix scoped API-key endpoint to change permissions.',
        });
    }
    if (
        (ctx.path === '/api-key/create' || ctx.path === '/api-key/update') &&
        ctx.body &&
        Object.hasOwn(ctx.body, 'vectorixLegacyFullAccess')
    ) {
        throw new APIError('FORBIDDEN', {
            message: 'Legacy API-key access cannot be assigned.',
        });
    }
});

/** Clears a removed member's stale active-organization sessions. */
export async function clearRemovedMemberSessions(member: {
    userId: string;
    organizationId: string;
}) {
    await prisma.session.updateMany({
        where: {
            userId: member.userId,
            activeOrganizationId: member.organizationId,
        },
        data: { activeOrganizationId: null },
    });
}
