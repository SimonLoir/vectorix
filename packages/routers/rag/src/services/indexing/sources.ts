import type { AuthorizedContext } from '@routers/utils/authorized';
import { readObject, StorageError } from '@repo/storage';
import { decodeStoredExtraction } from '@repo/documents';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { boundStorage, contentHash } from '../documents/storage';
import { indexError, safeIndexError } from './errors';
import { SOURCE_IO_ALLOWANCE_MS } from './source-retention';
import { beginSourceLease, completeSourceLease } from './source-lease';
import { readSourceChunks } from './source-projection';

/** Serve the immutable indexed version, even while the library publishes a replacement; recheck grants after private I/O. */
export async function previewIndexedSource(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        receipt: string;
        sourceIndex?: number;
        offset: number;
    }
) {
    try {
        const lease = await beginSourceLease(context, input);
        const { receipt, publication, startedAt } = lease;
        const bytes = await readObject(
            await boundStorage(
                context.db,
                receipt.organizationId,
                publication.extraction.storageLocationId
            ),
            publication.extraction.objectKey,
            MAX_DOCUMENT_BYTES
        );
        const extraction = decodeStoredExtraction(
            bytes,
            publication.extractorVersion
        );
        const projected = await readSourceChunks(context.db, lease, {
            before: 0,
            after: 0,
            includeText: false,
        });
        const spans = projected[0]?.sourceSpans;
        const first = Array.isArray(spans) ? spans[0] : null;
        const firstSource =
            typeof first === 'object' && first !== null && 'source' in first
                ? first.source
                : null;
        const defaultIndex =
            typeof firstSource === 'object' &&
            firstSource !== null &&
            'index' in firstSource &&
            typeof firstSource.index === 'number'
                ? firstSource.index
                : 0;
        const source = extraction.sources[input.sourceIndex ?? defaultIndex];
        if (!source || input.offset > source.end - source.start)
            throw indexError('SOURCE_UNAVAILABLE');
        const text = extraction.text.slice(source.start, source.end);
        if (
            input.offset > 0 &&
            /[\uDC00-\uDFFF]/.test(text.charAt(input.offset))
        )
            throw indexError('SOURCE_UNAVAILABLE', 'BAD_REQUEST');
        let end = Math.min(text.length, input.offset + 20_000);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)))
            end--;
        if (Date.now() - startedAt > SOURCE_IO_ALLOWANCE_MS)
            throw indexError('SOURCE_UNAVAILABLE');
        await completeSourceLease(context, lease);
        return {
            documentName: publication.fileName,
            version: publication.sourceVersion.version,
            format:
                publication.mediaType === 'text/markdown'
                    ? ('MARKDOWN' as const)
                    : extraction.format,
            source,
            totalSources: extraction.sources.length,
            text: text.slice(input.offset, end),
            nextOffset: end < text.length ? end : null,
            totalCharacters: text.length,
            empty: text.length === 0,
        };
    } catch (error) {
        if (error instanceof StorageError)
            throw indexError('STORAGE_UNAVAILABLE');
        throw safeIndexError(error);
    }
}

/** Originals use the exact version's saved storage binding and checksum, never the library's latest-version endpoint. */
export async function downloadIndexedOriginal(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        receipt: string;
    }
) {
    try {
        const lease = await beginSourceLease(context, input);
        const { receipt, publication, startedAt } = lease;
        const version = publication.sourceVersion;
        const bytes = await readObject(
            await boundStorage(
                context.db,
                receipt.organizationId,
                version.storageLocationId
            ),
            version.objectKey,
            MAX_DOCUMENT_BYTES
        );
        if (
            contentHash(bytes) !== version.sha256 ||
            Date.now() - startedAt > SOURCE_IO_ALLOWANCE_MS
        )
            throw indexError('SOURCE_UNAVAILABLE');
        await completeSourceLease(context, lease);
        return new File([new Uint8Array(bytes)], publication.fileName, {
            type: 'application/octet-stream',
        });
    } catch (error) {
        if (error instanceof StorageError)
            throw indexError('STORAGE_UNAVAILABLE');
        throw safeIndexError(error);
    }
}
