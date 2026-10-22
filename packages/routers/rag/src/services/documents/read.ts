import { decodeStoredExtraction, publicIngestionTask } from '@repo/documents';
import { ORPCError } from '@orpc/server';
import { permits } from '@repo/auth/permissions';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { readObject } from '@repo/storage';
import {
    documentDetails,
    MAX_DOCUMENT_BYTES,
} from '@repo/api-contracts/v1/rag/documents';
import { ragActor } from '../access';
import {
    requireDocument,
    contentDocument,
    libraryWrite,
    requireReadableVersion,
} from './access';
import { boundStorage, contentHash } from './storage';

export async function getDocumentDetails(
    context: AuthorizedContext,
    id: string
) {
    const actor = await ragActor(context, context.db, { ragLibrary: ['read'] });
    const document = await requireDocument(context.db, actor, id);
    const published = await context.db.documentVersion.findFirst({
        where: {
            organizationId: actor.organizationId,
            documentId: id,
            status: 'READY',
            discardedAt: null,
            contentState: 'AVAILABLE',
        },
        orderBy: { version: 'desc' },
        include: { ingestion: true, extraction: true },
    });
    const version =
        published ??
        (await context.db.documentVersion.findFirst({
            where: { organizationId: actor.organizationId, documentId: id },
            orderBy: { version: 'desc' },
            include: { ingestion: true, extraction: true },
        }));
    return documentDetails.parse({
        document,
        canManage: !actor.keyId && permits(actor.permissions, libraryWrite),
        version: version
            ? {
                  id: version.id,
                  version: version.version,
                  status: version.status,
                  byteSize: Number(version.byteSize),
                  mediaType: version.mediaType,
                  createdAt: version.createdAt,
                  stored: Boolean(
                      version.storedAt &&
                      !version.discardedAt &&
                      version.contentState === 'AVAILABLE'
                  ),
                  retryable: Boolean(
                      version.ingestion?.status === 'FAILED' &&
                      !version.discardedAt &&
                      version.contentState === 'AVAILABLE'
                  ),
                  previewAvailable: Boolean(
                      version.extraction &&
                      !version.extraction.discardedAt &&
                      !version.discardedAt &&
                      version.contentState === 'AVAILABLE' &&
                      version.status === 'READY'
                  ),
                  task: publicIngestionTask(version.ingestion),
              }
            : null,
    });
}
/** Read private objects on the server, then recheck current access before returning any bytes. */
export async function downloadDocument(context: AuthorizedContext, id: string) {
    const { document, actor, version } = await contentDocument(context, id);
    if (!version.storedAt)
        throw new ORPCError('CONFLICT', {
            message: 'The original upload is not available yet.',
        });
    const bytes = await readObject(
        await boundStorage(
            context.db,
            actor.organizationId,
            version.storageLocationId
        ),
        version.objectKey,
        MAX_DOCUMENT_BYTES
    );
    if (contentHash(bytes) !== version.sha256)
        throw new ORPCError('CONFLICT', {
            message:
                'The stored original does not match its recorded checksum.',
        });
    await requireReadableVersion(context, id, version.id);
    return new File(
        [new Uint8Array(bytes)],
        version.fileName ?? document.name,
        {
            type: 'application/octet-stream',
        }
    );
}
export async function previewDocument(
    context: AuthorizedContext,
    input: { id: string; offset: number }
) {
    const { actor, version } = await contentDocument(context, input.id);
    if (
        !version.extraction ||
        version.extraction.discardedAt ||
        version.status !== 'READY'
    )
        throw new ORPCError('CONFLICT', {
            message: 'The extracted text is not ready.',
        });
    const bytes = await readObject(
        await boundStorage(
            context.db,
            actor.organizationId,
            version.extraction.storageLocationId
        ),
        version.extraction.objectKey,
        MAX_DOCUMENT_BYTES
    );
    const { text } = decodeStoredExtraction(
        bytes,
        version.extraction.extractorVersion
    );
    await requireReadableVersion(context, input.id, version.id);
    if (input.offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(input.offset)))
        throw new ORPCError('BAD_REQUEST');
    let end = Math.min(text.length, input.offset + 20_000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1)))
        end--;
    return {
        text: text.slice(input.offset, end),
        nextOffset: end < text.length ? end : null,
        totalCharacters: text.length,
        version: version.version,
    };
}

/** Resolve only the currently published, authorized extraction; citations are bounded within one retained source. */
export async function previewDocumentSource(
    context: AuthorizedContext,
    input: { id: string; sourceIndex: number; offset: number }
) {
    const { actor, version } = await contentDocument(context, input.id);
    if (
        !version.extraction ||
        version.extraction.discardedAt ||
        version.status !== 'READY'
    )
        throw new ORPCError('CONFLICT', {
            message: 'The extracted text is not ready.',
        });
    const bytes = await readObject(
        await boundStorage(
            context.db,
            actor.organizationId,
            version.extraction.storageLocationId
        ),
        version.extraction.objectKey,
        MAX_DOCUMENT_BYTES
    );
    const extraction = decodeStoredExtraction(
        bytes,
        version.extraction.extractorVersion
    );
    const source = extraction.sources[input.sourceIndex];
    if (!source || input.offset > source.end - source.start)
        throw new ORPCError('BAD_REQUEST');
    const fullText = extraction.text.slice(source.start, source.end);
    if (
        input.offset > 0 &&
        /[\uDC00-\uDFFF]/.test(fullText.charAt(input.offset))
    )
        throw new ORPCError('BAD_REQUEST');
    let end = Math.min(fullText.length, input.offset + 20_000);
    if (
        end < fullText.length &&
        /[\uD800-\uDBFF]/.test(fullText.charAt(end - 1))
    )
        end--;
    await requireReadableVersion(context, input.id, version.id);
    return {
        format:
            version.mediaType === 'text/markdown'
                ? ('MARKDOWN' as const)
                : extraction.format,
        version: version.version,
        source,
        totalSources: extraction.sources.length,
        text: fullText.slice(input.offset, end),
        nextOffset: end < fullText.length ? end : null,
        totalCharacters: fullText.length,
        warnings: extraction.warnings.filter(
            (warning) => warning.sourceIndex === source.index
        ),
    };
}
