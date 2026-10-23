import { prisma, type Prisma } from '@repo/db';

/** Native session data only; request bodies and previous-session history are not inputs. */
export type InitialOrganizationSession = Readonly<{
    userId: string;
    activeOrganizationId?: unknown;
}>;

/**
 * Preserve a current active membership when Better Auth rotates a session.
 * Fresh sessions, or rotations with an ineligible selection, use the oldest
 * active membership with an ID tie-breaker. At most two single-row reads select
 * only the organization ID; no eligible membership explicitly means null.
 *
 * This selection does not grant access or lock membership/activity for the
 * session lifetime. Normal request authorization still checks current state.
 * Database errors propagate rather than masquerading as an empty membership.
 */
export async function resolveInitialOrganization(
    session: InitialOrganizationSession,
    db: Pick<Prisma.TransactionClient, 'member'> = prisma
): Promise<string | null> {
    if (
        typeof session.activeOrganizationId === 'string' &&
        session.activeOrganizationId.length > 0
    ) {
        const current = await db.member.findFirst({
            where: {
                userId: session.userId,
                organizationId: session.activeOrganizationId,
                organization: { isActive: true },
            },
            select: { organizationId: true },
        });
        if (current) return current.organizationId;
    }

    const membership = await db.member.findFirst({
        where: {
            userId: session.userId,
            organization: { isActive: true },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { organizationId: true },
    });
    return membership?.organizationId ?? null;
}
