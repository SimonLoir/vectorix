import { ORPCError, onError } from '@orpc/server';
import { auth } from '@repo/auth';
import type { PrismaClient } from '@repo/db';
import { base, type ApiContext } from './base';

const authorizeSuperAdmin = async (headers: Headers, db: PrismaClient) => {
    if (headers.has('x-api-key')) {
        throw new ORPCError('FORBIDDEN', {
            message: 'Super admin routes do not accept organization API keys',
        });
    }

    const sessionData = await auth.api.getSession({ headers });
    if (!sessionData?.session || !sessionData.user) {
        throw new ORPCError('UNAUTHORIZED');
    }

    const user = await db.user.findUnique({
        where: { id: sessionData.user.id },
        select: {
            id: true,
            name: true,
            email: true,
            image: true,
            isSuperAdmin: true,
        },
    });

    if (!user?.isSuperAdmin) {
        throw new ORPCError('FORBIDDEN', {
            message: 'Super admin access required',
        });
    }

    return {
        session: sessionData.session,
        user: {
            ...user,
            isSuperAdmin: true as const,
        },
    };
};

export type SuperAdminContext = ApiContext &
    Awaited<ReturnType<typeof authorizeSuperAdmin>>;

export const superAdminMiddleware = base.middleware(async ({ context, next }) =>
    next({
        context: await authorizeSuperAdmin(context.headers, context.db),
    })
);

export const superAdmin = base
    .use(
        onError((error) => {
            if (error instanceof ORPCError) {
                throw error;
            }
        })
    )
    .use(superAdminMiddleware);
