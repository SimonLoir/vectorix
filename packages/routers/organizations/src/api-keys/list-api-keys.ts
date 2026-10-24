import { ORPCError } from '@orpc/server';
import type { PermissionSet } from '@repo/auth/permissions';
import { LEGACY_LIST_LIMIT } from '@repo/api-contracts/v1/list-window';
import { adminOrganizationsV1 } from '../v1-implementer';

/** Lists a server-side window of safe key metadata for a session-authenticated member. */
export const listScopedApiKeys = adminOrganizationsV1.apiKeys.list.handler(
    async ({ context, input }) => {
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const query = input.query?.trim();
        const where = {
            configId: 'org',
            referenceId: context.organizationId,
            ...(query
                ? { name: { contains: query, mode: 'insensitive' as const } }
                : {}),
        };
        const [keys, total] = await context.db.$transaction([
            context.db.apikey.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    createdAt: true,
                    expiresAt: true,
                    enabled: true,
                    permissions: true,
                    ragPrincipal: {
                        select: {
                            memberId: true,
                            scopes: {
                                select: {
                                    collectionId: true,
                                    read: true,
                                    manageDocuments: true,
                                },
                            },
                        },
                    },
                    vectorixLegacyFullAccess: true,
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                skip: input.offset ?? 0,
                take: input.limit ?? LEGACY_LIST_LIMIT,
            }),
            context.db.apikey.count({ where }),
        ]);
        return {
            total,
            keys: keys.map(
                ({
                    vectorixLegacyFullAccess,
                    permissions,
                    ragPrincipal,
                    enabled,
                    ...key
                }) => ({
                    ...key,
                    issuerMemberId: ragPrincipal?.memberId ?? null,
                    collectionScopes: ragPrincipal?.scopes ?? [],
                    enabled: enabled ?? true,
                    legacyFullAccess: vectorixLegacyFullAccess,
                    permissions: permissions
                        ? (JSON.parse(permissions) as PermissionSet)
                        : {},
                })
            ),
        };
    }
);
