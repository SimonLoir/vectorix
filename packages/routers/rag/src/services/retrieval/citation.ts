import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    beginSourceLease,
    completeSourceLease,
    sourceLeaseReference,
    type SourceInput,
    type SourceLease,
} from '../indexing/source-lease';
import {
    readSourceChunks,
    type SourceChunk,
} from '../indexing/source-projection';
import { safeIndexError } from '../indexing/errors';

/** Citation identity comes only from the verified publication and bounded canonical row. */
export function sourceCitationMetadata(lease: SourceLease, chunk: SourceChunk) {
    return {
        chunkId: chunk.chunkId,
        generationId: lease.receipt.generationId,
        publicationId: lease.receipt.publicationId,
        documentId: lease.publication.documentId,
        documentName: lease.publication.fileName,
        version: lease.publication.sourceVersion.version,
        ordinal: chunk.ordinal,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        sourceSpans: chunk.sourceSpans,
        sourceSpansTruncated: chunk.sourceSpansTruncated,
    };
}

/** Resolve metadata for an exact receipt without contacting object storage or a provider. */
export async function resolveRetrievalCitation(
    context: AuthorizedContext,
    input: SourceInput
) {
    try {
        const lease = await beginSourceLease(context, input);
        const chunks = await readSourceChunks(context.db, lease, {
            before: 0,
            after: 0,
            includeText: false,
        });
        await completeSourceLease(context, lease);
        return {
            ...sourceCitationMetadata(lease, chunks[0]!),
            source: sourceLeaseReference(lease),
        };
    } catch (error) {
        throw safeIndexError(error);
    }
}
