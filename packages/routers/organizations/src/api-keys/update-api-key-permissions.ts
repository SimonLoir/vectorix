import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    auditKeyPermissions,
    bindKeyScopes,
} from '@routers/rag/api-key-scopes';
import { adminOrganizationsV1 } from '../v1-implementer';
import { scopedKeyPermissions } from './scoped-permissions';

/** Atomically update permissions and optional collection scopes, retaining the original issuer. */
export const updateScopedApiKeyPermissions =
    adminOrganizationsV1.apiKeys.updatePermissions.handler(
        async ({ context, input }) => {
            const permissions = await scopedKeyPermissions(
                context,
                input.permissions
            );
            return runSerializableTransaction(context.db, async (db) => {
                await auditKeyPermissions(
                    context,
                    db,
                    input.keyId,
                    permissions
                );
                const result = await db.apikey.updateMany({
                    where: {
                        id: input.keyId,
                        configId: 'org',
                        referenceId: context.organizationId,
                    },
                    data: {
                        permissions: JSON.stringify(permissions),
                        vectorixLegacyFullAccess: false,
                        updatedAt: new Date(),
                    },
                });
                if (!result.count) throw new ORPCError('NOT_FOUND');
                if (input.collectionScopes !== undefined)
                    await bindKeyScopes(
                        context,
                        db,
                        input.keyId,
                        input.collectionScopes
                    );
                return { success: true };
            });
        }
    );
