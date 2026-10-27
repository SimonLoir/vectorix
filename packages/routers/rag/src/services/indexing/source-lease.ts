import type { AuthorizedContext } from '@routers/utils/authorized';
import type { Prisma } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { requireIndexRead } from './access';
import { verifySourceReceipt, type SourceReceipt } from './receipts';
import { renewSourceHold } from './source-holds';
import { indexError } from './errors';
import { SOURCE_IO_ALLOWANCE_MS } from './source-retention';

export type SourceInput = { collectionId: string; receipt: string };

/** The receipt is provenance, never authority: detached, deleted or destructively cleaning sources fail closed. */
async function exactSource(
    context: AuthorizedContext,
    receipt: SourceReceipt,
    db: Prisma.TransactionClient = context.db
) {
    await requireIndexRead(context, receipt.collectionId, db);
    const publication = await db.indexedDocument.findFirst({
        where: {
            id: receipt.publicationId,
            organizationId: receipt.organizationId,
            collectionId: receipt.collectionId,
            generationId: receipt.generationId,
            sourceVersionId: receipt.versionId,
            extractionId: receipt.extractionId,
            status: { in: ['PUBLISHED', 'RETIRED'] },
            generation: { status: { in: ['ACTIVE', 'RETIRED'] } },
            sourceVersion: {
                discardedAt: null,
                contentState: 'AVAILABLE',
                document: {
                    deletedAt: null,
                    collections: {
                        some: {
                            organizationId: receipt.organizationId,
                            collectionId: receipt.collectionId,
                        },
                    },
                },
            },
            extraction: { discardedAt: null },
            sourceHold: {
                OR: [
                    { state: 'LIVE' },
                    { state: 'RETIRED', retainUntil: { gt: new Date() } },
                ],
            },
            chunks: {
                some: {
                    id: receipt.chunkId,
                    kind: 'CHILD',
                    organizationId: receipt.organizationId,
                },
            },
        },
        include: {
            sourceVersion: true,
            extraction: true,
            chunks: {
                where: { id: receipt.chunkId, kind: 'CHILD' },
                take: 1,
                select: { id: true, ordinal: true },
            },
        },
    });
    if (!publication || !publication.chunks[0])
        throw indexError('SOURCE_UNAVAILABLE');
    return publication;
}

/** Fence the exact source against cleanup without renewing the signed receipt's original expiry. */
export async function beginSourceLease(
    context: AuthorizedContext,
    input: SourceInput
) {
    const startedAt = Date.now();
    const { actor } = await requireIndexRead(context, input.collectionId);
    const receipt = verifySourceReceipt(
        input.receipt,
        actor.organizationId,
        input.collectionId
    );
    const publication = await runSerializableTransaction(
        context.db,
        async (db) => {
            const result = await exactSource(context, receipt, db);
            if (
                !(await renewSourceHold(db, {
                    organizationId: actor.organizationId,
                    indexedDocumentId: result.id,
                    retainUntil: new Date(startedAt + SOURCE_IO_ALLOWANCE_MS),
                }))
            )
                throw indexError('SOURCE_UNAVAILABLE');
            return result;
        }
    );
    if (Date.now() - startedAt > SOURCE_IO_ALLOWANCE_MS)
        throw indexError('SOURCE_UNAVAILABLE');
    return { receipt, publication, startedAt, originalReceipt: input.receipt };
}
export type SourceLease = Awaited<ReturnType<typeof beginSourceLease>>;

/** Recheck live grants, issuer/scopes, association, retention and signed expiry after content hydration. */
export async function completeSourceLease(
    context: AuthorizedContext,
    lease: SourceLease
) {
    if (Date.now() - lease.startedAt > SOURCE_IO_ALLOWANCE_MS)
        throw indexError('SOURCE_UNAVAILABLE');
    verifySourceReceipt(
        lease.originalReceipt,
        lease.receipt.organizationId,
        lease.receipt.collectionId
    );
    await exactSource(context, lease.receipt);
    if (Date.now() - lease.startedAt > SOURCE_IO_ALLOWANCE_MS)
        throw indexError('SOURCE_UNAVAILABLE');
    verifySourceReceipt(
        lease.originalReceipt,
        lease.receipt.organizationId,
        lease.receipt.collectionId
    );
}

/** Preserve the exact caller-provided anchor token, including its original deadline. */
export function sourceLeaseReference(lease: SourceLease) {
    return {
        receipt: lease.originalReceipt,
        expiresAt: new Date(lease.receipt.expiresAt),
    };
}
