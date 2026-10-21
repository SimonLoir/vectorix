import { oc } from '@orpc/contract';
import { z } from 'zod';

const pagination = z.object({
    page: z
        .union([z.number(), z.string().regex(/^\d+$/)])
        .pipe(z.coerce.number<string | number>().int().min(1).max(100_000))
        .default(1),
    limit: z
        .union([z.number(), z.string().regex(/^\d+$/)])
        .pipe(z.coerce.number<string | number>().int().min(1).max(100))
        .default(25),
});
const userId = z.string().trim().min(1).max(200);

/** Safe global account projection; credentials, sessions and authentication secrets remain private. */
export const superAdminUserV1Schema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
    isSuperAdmin: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
    _count: z.object({ members: z.number().int().nonnegative() }),
});

export const superAdminUsersV1Contract = {
    list: oc
        .route({ method: 'GET', path: '/' })
        .input(
            pagination
                .extend({
                    search: z.string().trim().max(200).optional(),
                    access: z.enum(['superadmin', 'standard']).optional(),
                })
                .strict()
                .prefault({})
        )
        .output(
            z.object({
                users: z.array(superAdminUserV1Schema),
                total: z.number().int().nonnegative(),
            })
        ),
    get: oc
        .route({ method: 'GET', path: '/{userId}' })
        .input(pagination.extend({ userId }).strict())
        .output(
            z.object({
                user: superAdminUserV1Schema,
                superAdminCount: z.number().int().nonnegative(),
                memberships: z.array(
                    z.object({
                        id: z.string(),
                        role: z.string(),
                        createdAt: z.date(),
                        organization: z.object({
                            id: z.string(),
                            name: z.string(),
                            slug: z.string(),
                            isActive: z.boolean(),
                        }),
                    })
                ),
                totalMemberships: z.number().int().nonnegative(),
            })
        ),
    setSuperAdmin: oc
        .route({
            method: 'PUT',
            path: '/{userId}/superadmin-access',
            description:
                'Grant or revoke console superadmin access for an existing user. Requires a live superadmin session, checks the displayed user version and role, preserves the last superadmin and audits changes atomically. Organization roles and credentials are unchanged.',
        })
        .input(
            z.strictObject({
                userId,
                enabled: z.boolean(),
                expectedIsSuperAdmin: z.boolean(),
                expectedUpdatedAt: z
                    .union([z.date(), z.iso.datetime({ offset: true })])
                    .pipe(z.coerce.date()),
            })
        )
        .output(superAdminUserV1Schema),
};
