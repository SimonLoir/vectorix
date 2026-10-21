import { onSessionCreated } from '@repo/auth';
import { prisma } from '@repo/db';
import { logger } from './lib/logger';

/**
 * Turns every new Better Auth session into ACCOUNT_SIGN_IN notification
 * intents. The producer loads on first sign-in; failures are logged
 * and never block sign-in.
 */
export function registerSignInNotifications() {
    onSessionCreated(async (session) => {
        try {
            const { enqueueAccountSignInNotifications } =
                await import('@routers/utils/notifications');
            await enqueueAccountSignInNotifications(prisma, {
                userId: session.userId,
                sessionId: session.id,
                activeOrganizationId: session.activeOrganizationId,
                occurredAt: session.createdAt,
                ipAddress: session.ipAddress,
                userAgent: session.userAgent,
            });
        } catch (error) {
            logger.warn(
                { err: error, userId: session.userId },
                'Sign-in notification could not be recorded'
            );
        }
    });
}
