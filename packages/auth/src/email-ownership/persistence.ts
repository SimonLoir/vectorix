import { prisma, Prisma } from '@repo/db';
import { APIError } from 'better-auth/api';
import { emailOwnershipError } from './errors';
import type { EmailOwnershipClaims } from './tokens';

/**
 * Recheck the live session and bind the write to the immutable user ID and old
 * email in one transaction. The native route's separate email lookup/write
 * cannot express this predicate and is never invoked for redemption.
 */
export async function applyEmailOwnershipProof(input: {
    claims: EmailOwnershipClaims;
    sessionId: string;
    confirmationOnly?: boolean;
}) {
    try {
        return await prisma.$transaction(async (tx) => {
            const session = await tx.session.findFirst({
                where: {
                    id: input.sessionId,
                    userId: input.claims.userId,
                    expiresAt: { gt: new Date() },
                },
                select: { id: true },
            });
            if (!session)
                throw emailOwnershipError(
                    'EMAIL_VERIFICATION_SESSION_REQUIRED'
                );
            const user = await tx.user.findUnique({
                where: { id: input.claims.userId },
            });
            if (!user || user.email.toLowerCase() !== input.claims.email)
                throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
            if (input.claims.updateTo && user.emailVerified !== true) {
                throw emailOwnershipError(
                    'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED'
                );
            }
            if (input.confirmationOnly) {
                if (!user.emailVerified)
                    throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
                return user;
            }
            if (input.claims.updateTo) {
                const occupied = await tx.user.findFirst({
                    where: {
                        id: { not: user.id },
                        email: {
                            equals: input.claims.updateTo,
                            mode: 'insensitive',
                        },
                    },
                    select: { id: true },
                });
                if (occupied)
                    throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
            }
            const changed = await tx.user.updateMany({
                where: { id: user.id, email: user.email },
                data: {
                    emailVerified: true,
                    ...(input.claims.updateTo
                        ? { email: input.claims.updateTo }
                        : {}),
                },
            });
            if (changed.count !== 1)
                throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
            return await tx.user.findUniqueOrThrow({ where: { id: user.id } });
        });
    } catch (error) {
        if (error instanceof APIError) throw error;
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            ['P2002', 'P2025', 'P2034'].includes(error.code)
        ) {
            throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
        }
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
}
