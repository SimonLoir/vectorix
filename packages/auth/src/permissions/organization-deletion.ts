import { APIError } from 'better-auth/api';
import type { Prisma } from '@repo/db';

/**
 * Organization cascades cannot remove the durable instructions needed to delete
 * private objects or vector tables. The database trigger is the concurrent-write
 * backstop; this ORM preflight gives native auth clients an actionable API error.
 */
export async function requireOrganizationCleanup(
    db: Prisma.TransactionClient,
    organizationId: string
): Promise<void> {
    const [versions, generations] = await Promise.all([
        db.documentVersion.count({
            where: {
                organizationId,
                OR: [
                    { discardedAt: null },
                    { contentState: { not: 'PURGED' } },
                    { cleanup: { status: { not: 'COMPLETE' } } },
                    { ingestion: { reservedBytes: { gt: 0n } } },
                ],
            },
        }),
        db.indexGeneration.count({
            where: { organizationId, status: { not: 'CLEANED' } },
        }),
    ]);
    if (versions || generations)
        throw new APIError('CONFLICT', {
            code: 'ORGANIZATION_CONTENT_CLEANUP_REQUIRED',
            message:
                'Delete the organization’s collections and documents, then wait for their storage and index cleanup before deleting the organization.',
        });
}
