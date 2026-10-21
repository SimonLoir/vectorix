import { oc } from '@orpc/contract';
import { z } from 'zod';
import { collectionScopes } from '../rag/common';

// Explicit V1 DTOs, independent of both Prisma and the mutable permission catalogue.
const PermissionsV1Schema = z.record(z.string(), z.array(z.string()));
const empty = z.object({}).strict().default({});

export const organizationAccessV1Contract = {
    access: oc
        .route({
            method: 'GET',
            path: '/access',
            description:
                'Read the current member permissions and assignable organization roles',
        })
        .input(empty)
        .output(
            z.object({
                memberId: z.string(),
                role: z.string(),
                permissions: PermissionsV1Schema,
                roles: z.array(
                    z.object({
                        role: z.string(),
                        permissions: PermissionsV1Schema,
                        builtIn: z.boolean(),
                        assignable: z.boolean(),
                    })
                ),
            })
        ),
    apiKeys: {
        list: oc
            .route({
                method: 'GET',
                path: '/api-keys',
                description: 'List organization API keys without their secrets',
            })
            .input(empty)
            .output(
                z.object({
                    keys: z.array(
                        z.object({
                            id: z.string(),
                            name: z.string().nullable(),
                            createdAt: z.date(),
                            expiresAt: z.date().nullable(),
                            enabled: z.boolean(),
                            legacyFullAccess: z.boolean(),
                            permissions: PermissionsV1Schema,
                            collectionScopes,
                            issuerMemberId: z.string().nullable(),
                        })
                    ),
                })
            ),
        create: oc
            .route({
                method: 'POST',
                path: '/api-keys',
                description:
                    'Create a key with explicit limited business permissions; full-access keys cannot be issued',
            })
            .input(
                z.object({
                    name: z.string().trim().min(1).max(64),
                    permissions: PermissionsV1Schema,
                    collectionScopes: collectionScopes.optional(),
                })
            )
            .output(z.object({ id: z.string(), key: z.string() })),
        updatePermissions: oc
            .route({
                method: 'PUT',
                path: '/api-keys/{keyId}/permissions',
                description:
                    'Set limited permissions and permanently remove any legacy full access',
            })
            .input(
                z.object({
                    keyId: z.string(),
                    permissions: PermissionsV1Schema,
                    collectionScopes: collectionScopes.optional(),
                })
            )
            .output(z.object({ success: z.boolean() })),
    },
};
