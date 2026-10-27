import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    beginSourceLease,
    completeSourceLease,
    sourceLeaseReference,
    type SourceInput,
} from '../indexing/source-lease';
import { readSourceChunks } from '../indexing/source-projection';
import { deriveSourceReceipt } from '../indexing/receipts';
import { indexError, safeIndexError } from '../indexing/errors';
import { sourceCitationMetadata } from './citation';

/** Expand whole canonical children around a signed hit, never crossing its publication/version or extending receipt life. */
export async function expandRetrievalContext(
    context: AuthorizedContext,
    input: SourceInput & { before: number; after: number }
) {
    try {
        const lease = await beginSourceLease(context, input);
        const chunks = await readSourceChunks(context.db, lease, {
            ...input,
            includeText: true,
        });
        const anchor = lease.publication.chunks[0]!;
        if (
            chunks.reduce(
                (total, chunk) => total + (chunk.text?.length ?? 0),
                0
            ) > 245_760
        )
            throw indexError('CHUNK_LIMIT');
        await completeSourceLease(context, lease);
        return {
            anchorChunkId: lease.receipt.chunkId,
            generationId: lease.receipt.generationId,
            documentId: lease.publication.documentId,
            documentName: lease.publication.fileName,
            version: lease.publication.sourceVersion.version,
            source: sourceLeaseReference(lease),
            passages: chunks.map((chunk) => ({
                ...sourceCitationMetadata(lease, chunk),
                text: chunk.text!,
                relation:
                    chunk.ordinal < anchor.ordinal
                        ? ('BEFORE' as const)
                        : chunk.ordinal > anchor.ordinal
                          ? ('AFTER' as const)
                          : ('MATCH' as const),
                source:
                    chunk.chunkId === lease.receipt.chunkId
                        ? sourceLeaseReference(lease)
                        : deriveSourceReceipt(lease.receipt, chunk.chunkId),
            })),
        };
    } catch (error) {
        throw safeIndexError(error);
    }
}
