import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import {
    validatePermissions,
    type PermissionSet,
} from '@repo/auth/permissions';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';

type VerifiedKeyReference = Readonly<{
    keyId: string;
    organizationId: string;
}>;

/** Native verification authenticates the secret; current database state remains authoritative. */
async function currentKey(
    db: Prisma.TransactionClient,
    reference: VerifiedKeyReference
) {
    const key = await db.apikey.findUnique({
        where: { id: reference.keyId },
        select: {
            configId: true,
            referenceId: true,
            enabled: true,
            expiresAt: true,
            vectorixLegacyFullAccess: true,
            permissions: true,
        },
    });
    if (
        !key ||
        key.configId !== 'org' ||
        key.referenceId !== reference.organizationId ||
        key.enabled === false ||
        (key.expiresAt && key.expiresAt <= new Date())
    )
        throw new ORPCError('INVALID_API_KEY', { status: 401 });
    return key;
}

function scopedPermissions(value: string | null): PermissionSet {
    try {
        return validatePermissions(JSON.parse(value ?? '{}'), true);
    } catch {
        // Neither stored permission payloads nor parser diagnostics belong in errors or logs.
        throw new ORPCError('FORBIDDEN');
    }
}

/**
 * Intersect a verified organization's key scope with its bound issuer's current
 * membership and role definitions on every admission. Historical/unbound keys
 * must be reissued, never attributed to the current session or another owner.
 * This does not cancel requests admitted before a subsequent revocation.
 */
export async function resolveCurrentApiKeyAccess(
    db: Prisma.TransactionClient,
    reference: VerifiedKeyReference
): Promise<PermissionSet> {
    const key = await currentKey(db, reference);
    if (key.vectorixLegacyFullAccess) throw new ORPCError('FORBIDDEN');
    const principal = await db.apiKeyPrincipal.findFirst({
        where: {
            organizationId: reference.organizationId,
            keyId: reference.keyId,
        },
        select: {
            memberId: true,
            member: {
                select: {
                    userId: true,
                    organization: { select: { isActive: true } },
                },
            },
        },
    });
    if (!principal || !principal.member.organization.isActive)
        throw new ORPCError('FORBIDDEN');
    const membership = await getMemberPermissions(
        reference.organizationId,
        principal.member.userId,
        db
    );
    if (!membership || membership.member.id !== principal.memberId)
        throw new ORPCError('FORBIDDEN');
    const permissions = scopedPermissions(key.permissions);
    return Object.fromEntries(
        Object.entries(permissions).map(([resource, actions]) => [
            resource,
            actions.filter((action) =>
                membership.permissions[resource]?.includes(action)
            ),
        ])
    );
}
