import { auth } from '@repo/auth';
import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    authorizeKeyMutation,
    bindKeyScopes,
    validateKeyScopes,
} from '@routers/rag/api-key-scopes';
import { adminOrganizationsV1 } from '../v1-implementer';
import { scopedKeyPermissions } from './scoped-permissions';

/** Native key generation/hash storage with explicit issuer binding and scoped delegation checks. */
export const createScopedApiKey = adminOrganizationsV1.apiKeys.create.handler(
    async ({ context, input }) => {
        const permissions = await scopedKeyPermissions(
            context,
            input.permissions
        );
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const scopes = input.collectionScopes ?? [];
        await validateKeyScopes(context, context.db, scopes);
        const key = await auth.api.createApiKey({
            body: {
                configId: 'org',
                organizationId: context.organizationId,
                userId: context.user.id,
                name: input.name,
                permissions,
            },
        });
        try {
            await runSerializableTransaction(context.db, async (db) => {
                await authorizeKeyMutation(context, db, permissions, 'create');
                await bindKeyScopes(context, db, key.id, scopes, true);
            });
        } catch (error) {
            // No secret was returned yet. Remove only the key created by this request.
            await context.db.apikey.deleteMany({
                where: {
                    id: key.id,
                    configId: 'org',
                    referenceId: context.organizationId,
                },
            });
            throw error;
        }
        return { id: key.id, key: key.key };
    }
);
