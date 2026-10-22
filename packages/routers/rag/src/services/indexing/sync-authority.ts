import { ORPCError } from '@orpc/server';
import type { IndexGeneration, IndexTask, Prisma } from '@repo/db';
import {
    requireIndexDocumentAuthority,
    requireIndexRebuildAuthority,
} from './access';

export type SynchronizationGeneration = Pick<
    IndexGeneration,
    | 'id'
    | 'organizationId'
    | 'collectionId'
    | 'authorityUserId'
    | 'createdBy'
    | 'previousGenerationId'
    | 'status'
>;

/** Profile administration applies only while a replacement is unfinished, not after activation. */
export function isPendingRebuild(
    generation: Pick<IndexGeneration, 'previousGenerationId' | 'status'>
) {
    return Boolean(
        generation.previousGenerationId &&
        ['PROVISIONING', 'BUILDING', 'FAILED'].includes(generation.status)
    );
}

/**
 * Automatic UPSERT work uses its configured human controller. Historical null
 * initial/active generations retain event-actor behavior until explicitly adopted;
 * the existing pending-rebuild original-requester fallback remains compatible.
 */
export function automaticIndexUser(
    generation: SynchronizationGeneration,
    eventUserId: string
) {
    return (
        generation.authorityUserId ??
        (isPendingRebuild(generation) ? generation.createdBy : eventUserId)
    );
}

/** Metadata reports current rights, never caches a permission or invents a legacy controller. */
export async function synchronizationAuthorityState(
    db: Prisma.TransactionClient,
    generation: SynchronizationGeneration
): Promise<'AUTHORIZED' | 'ACCESS_REVOKED' | 'UNADOPTED'> {
    if (!generation.authorityUserId) return 'UNADOPTED';
    try {
        const principal = {
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            requestedBy: generation.authorityUserId,
        };
        await (isPendingRebuild(generation)
            ? requireIndexRebuildAuthority(db, principal)
            : requireIndexDocumentAuthority(db, principal));
        return 'AUTHORIZED';
    } catch (error) {
        if (
            error instanceof ORPCError &&
            (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
        )
            return 'ACCESS_REVOKED';
        throw error;
    }
}

/**
 * Activation checks the current controller independently from the last completed
 * task. Historical null first generations keep their previously accepted task
 * authority; explicit task retries remain valid per-task execution overrides.
 */
export async function requireSynchronizationActivationAuthority(
    db: Prisma.TransactionClient,
    generation: SynchronizationGeneration,
    completedTask: Pick<IndexTask, 'requestedBy'>
) {
    const principal = {
        organizationId: generation.organizationId,
        collectionId: generation.collectionId,
        requestedBy: automaticIndexUser(generation, completedTask.requestedBy),
    };
    return await (isPendingRebuild(generation)
        ? requireIndexRebuildAuthority(db, principal)
        : requireIndexDocumentAuthority(db, principal));
}
