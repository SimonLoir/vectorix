import type { Prisma } from '@repo/db';

interface SourceHoldIdentity {
    organizationId: string;
    indexedDocumentId: string;
}

/**
 * Pin exactly the immutable source used by a candidate. Call inside a serializable
 * transaction: writing contentFence serializes this decision with physical cleanup.
 * A retired/released candidate cannot regain a live hold through a delayed worker.
 */
export async function acquireSourceHold(
    tx: Prisma.TransactionClient,
    input: SourceHoldIdentity & { versionId: string }
): Promise<boolean> {
    const candidate = await tx.indexedDocument.findFirst({
        where: {
            id: input.indexedDocumentId,
            organizationId: input.organizationId,
            sourceVersionId: input.versionId,
            status: { in: ['STAGING', 'SEALED', 'PUBLISHED'] },
            extraction: { discardedAt: null },
        },
        select: { id: true },
    });
    if (!candidate) return false;
    const writable = await tx.documentVersion.updateMany({
        where: {
            id: input.versionId,
            organizationId: input.organizationId,
            contentState: 'AVAILABLE',
            discardedAt: null,
        },
        data: { contentFence: { increment: 1 } },
    });
    if (!writable.count) return false;
    const current = await tx.documentSourceHold.findUnique({
        where: { indexedDocumentId: input.indexedDocumentId },
    });
    if (current) return current.state === 'LIVE';
    await tx.documentSourceHold.create({ data: input });
    return true;
}

/** Retain a retired publication's source until its bounded citation/read grace expires. */
export async function retireSourceHold(
    tx: Prisma.TransactionClient,
    input: SourceHoldIdentity & { retainUntil: Date }
): Promise<boolean> {
    const hold = await tx.documentSourceHold.findFirst({
        where: {
            organizationId: input.organizationId,
            indexedDocumentId: input.indexedDocumentId,
            state: { in: ['LIVE', 'RETIRED'] },
        },
    });
    if (!hold) return false;
    const fenced = await tx.documentVersion.updateMany({
        where: {
            id: hold.versionId,
            organizationId: input.organizationId,
            contentState: 'AVAILABLE',
            discardedAt: null,
        },
        data: { contentFence: { increment: 1 } },
    });
    if (!fenced.count) return false;
    await tx.documentSourceHold.update({
        where: { id: hold.id },
        data: {
            state: 'RETIRED',
            retainUntil: new Date(
                Math.max(
                    input.retainUntil.getTime(),
                    hold.retainUntil?.getTime() ?? 0
                )
            ),
        },
    });
    return true;
}

/** Release only after vector/chunk retirement has been acknowledged; never perform object I/O in this transaction. */
export async function releaseSourceHold(
    tx: Prisma.TransactionClient,
    input: SourceHoldIdentity
): Promise<boolean> {
    const hold = await tx.documentSourceHold.findFirst({
        where: input,
    });
    if (!hold || hold.state === 'RELEASED') return false;
    await tx.documentVersion.updateMany({
        where: { id: hold.versionId, organizationId: input.organizationId },
        data: { contentFence: { increment: 1 } },
    });
    await tx.documentSourceHold.update({
        where: { id: hold.id },
        data: { state: 'RELEASED', releasedAt: new Date() },
    });
    return true;
}

/**
 * Extend an unexpired citation receipt while its exact source is still readable.
 * Callers bound retainUntil to the request grace; an expired receipt cannot be
 * resurrected, even before the cleaner has acquired its destructive claim.
 */
export async function renewSourceHold(
    tx: Prisma.TransactionClient,
    input: SourceHoldIdentity & { retainUntil: Date }
): Promise<boolean> {
    const now = new Date();
    const hold = await tx.documentSourceHold.findFirst({
        where: {
            organizationId: input.organizationId,
            indexedDocumentId: input.indexedDocumentId,
            OR: [
                { state: 'LIVE' },
                { state: 'RETIRED', retainUntil: { gt: now } },
            ],
        },
    });
    if (!hold) return false;
    const publication = await tx.indexedDocument.updateMany({
        where: {
            organizationId: input.organizationId,
            id: input.indexedDocumentId,
            status: { in: ['PUBLISHED', 'RETIRED'] },
        },
        data: { updatedAt: now },
    });
    if (!publication.count) return false;
    const fenced = await tx.documentVersion.updateMany({
        where: {
            id: hold.versionId,
            organizationId: input.organizationId,
            contentState: 'AVAILABLE',
            discardedAt: null,
        },
        data: { contentFence: { increment: 1 } },
    });
    if (!fenced.count) return false;
    if (hold.state === 'RETIRED')
        await tx.documentSourceHold.update({
            where: { id: hold.id },
            data: {
                retainUntil: new Date(
                    Math.max(
                        input.retainUntil.getTime(),
                        hold.retainUntil!.getTime()
                    )
                ),
            },
        });
    return true;
}
