import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import type { Prisma, Chunk, IndexedDocument, DocumentVersion } from '@repo/db';
import {
    chunkView,
    documentMetadata,
} from '@repo/api-contracts/v1/rag/indexing-types';
import { quotaLimits } from '../quotas';
import { ragActor } from '../access';
import {
    indexCapabilities,
    indexCleanupWhere,
    requireIndexDocuments,
    requireIndexRead,
} from './access';
import { publicIndexFailure } from './errors';

type Page = {
    collectionId: string;
    query: string;
    limit: number;
    offset: number;
};
type Publication = IndexedDocument & { sourceVersion: DocumentVersion };

/** Public canonical chunk projection is bounded independently of the full immutable provenance artifact. */
export function chunkDto(chunk: Chunk, publication: Publication) {
    const spans = Array.isArray(chunk.sourceSpans) ? chunk.sourceSpans : [];
    return chunkView.parse({
        ...chunk,
        publicationId: publication.id,
        documentId: publication.documentId,
        documentName: publication.fileName,
        version: publication.sourceVersion.version,
        sourceSpans: spans.slice(0, 64),
        sourceSpansTruncated: spans.length > 64,
        published: publication.status === 'PUBLISHED',
    });
}

/** Metadata-only progress does not grant access to chunks or document contents. */
export async function getIndexStatus(
    context: AuthorizedContext,
    collectionId: string
) {
    const access = await indexCapabilities(context, collectionId);
    const organizationId = access.actor.organizationId;
    const [generations, accounting, limits, configuration] = await Promise.all([
        context.db.indexGeneration.findMany({
            where: { organizationId, collectionId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 10,
            include: {
                configuration: true,
                _count: {
                    select: {
                        documents: true,
                    },
                },
            },
        }),
        context.db.collectionIndexAccounting.findUnique({
            where: { collectionId },
        }),
        quotaLimits(context.db, organizationId),
        context.db.collectionConfigRevision.findUnique({
            where: {
                ['organizationId_collectionId_revision']: {
                    organizationId,
                    collectionId,
                    revision: access.collection.configurationRevision,
                },
            },
        }),
    ]);
    const items = await Promise.all(
        generations.map(async (generation) => ({
            id: generation.id,
            status: generation.status,
            configurationRevision: generation.configurationRevision,
            model: generation.configuration.model,
            dimensions: generation.configuration.dimensions,
            modelIdentity: generation.modelIdentity,
            createdAt: generation.createdAt,
            activatedAt: generation.activatedAt,
            projectedChunks: Number(generation.projectedChunks),
            totalDocuments: generation._count.documents,
            publishedDocuments: await context.db.generationDocument.count({
                where: {
                    organizationId,
                    generationId: generation.id,
                    removedAt: null,
                    publishedIndexedDocumentId: { not: null },
                },
            }),
            errorCode: publicIndexFailure(generation.lastErrorCode),
        }))
    );
    const unsupported =
        !configuration ||
        configuration.provider !== 'OLLAMA' ||
        configuration.chunkingStrategy !== 'DOCUMENT_STRUCTURE' ||
        configuration.parentChild;
    return {
        configurationRevision: access.collection.configurationRevision,
        deletedAt: access.collection.deletedAt,
        canManage: access.canManage,
        canRead: access.canRead,
        unsupportedReason: unsupported
            ? ('PROFILE_UNSUPPORTED' as const)
            : null,
        active:
            items.find(
                (item) => item.id === access.collection.activeGenerationId
            ) ?? null,
        generations: items,
        usage: {
            activeChunks: Number(accounting?.activeChunks ?? 0n),
            retainedChunks: Number(accounting?.retainedChunks ?? 0n),
            reservedChunks: Number(accounting?.reservedChunks ?? 0n),
            activeLimit: limits.chunksPerCollection,
            temporaryLimit: limits.temporaryChunksPerCollection,
        },
    };
}

/** Durable task states remain inspectable after collection deletion; no provider diagnostics are returned. */
export async function listIndexTasks(context: AuthorizedContext, input: Page) {
    const access = await indexCapabilities(context, input.collectionId);
    const where: Prisma.IndexTaskWhereInput = {
        organizationId: access.actor.organizationId,
        collectionId: input.collectionId,
        ...(input.query
            ? { stage: { contains: input.query, mode: 'insensitive' } }
            : {}),
    };
    const [tasks, total] = await Promise.all([
        context.db.indexTask.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: input.limit,
            skip: input.offset,
            include: { indexedDocument: { select: { documentId: true } } },
        }),
        context.db.indexTask.count({ where }),
    ]);
    return {
        total,
        items: tasks.map((task) => ({
            id: task.id,
            generationId: task.generationId,
            publicationId: task.indexedDocumentId,
            documentId: task.indexedDocument?.documentId ?? null,
            kind: task.kind,
            status: task.status,
            stage: task.stage,
            attempts: task.attempts,
            completedChunks: task.completedChunks,
            reservedChunks: task.reservedChunks,
            errorCode: publicIndexFailure(task.errorCode),
            updatedAt: task.updatedAt,
            retryable:
                access.canManage &&
                task.status === 'FAILED' &&
                (!access.collection.deletedAt ||
                    ['CLEAN_PUBLICATION', 'CLEAN_GENERATION'].includes(
                        task.kind
                    )),
        })),
    };
}

/** Pagination/filtering happens in SQL before library names or collection-specific metadata are projected. */
export async function listIndexDocuments(
    context: AuthorizedContext,
    input: Page
) {
    const { actor, collection } = await requireIndexDocuments(
        context,
        input.collectionId
    );
    if (collection.deletedAt) throw new ORPCError('NOT_FOUND');
    const generation =
        collection.activeGenerationId ??
        (
            await context.db.indexGeneration.findFirst({
                where: {
                    organizationId: actor.organizationId,
                    collectionId: input.collectionId,
                    status: { in: ['PROVISIONING', 'BUILDING', 'FAILED'] },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                select: { id: true },
            })
        )?.id;
    const where: Prisma.CollectionDocumentWhereInput = {
        organizationId: actor.organizationId,
        collectionId: input.collectionId,
        document: {
            deletedAt: null,
            name: { contains: input.query, mode: 'insensitive' },
        },
    };
    const [rows, total] = await Promise.all([
        context.db.collectionDocument.findMany({
            where,
            skip: input.offset,
            take: input.limit,
            orderBy: [{ createdAt: 'desc' }, { documentId: 'desc' }],
            include: {
                document: {
                    include: {
                        versions: {
                            where: {
                                discardedAt: null,
                                contentState: 'AVAILABLE',
                                status: 'READY',
                            },
                            orderBy: { version: 'desc' },
                            take: 1,
                        },
                        indexManifests: {
                            where: { generationId: generation ?? '' },
                            take: 1,
                            include: {
                                publishedIndexedDocument: {
                                    include: { sourceVersion: true },
                                },
                            },
                        },
                    },
                },
            },
        }),
        context.db.collectionDocument.count({ where }),
    ]);
    return {
        total,
        items: rows.map((row) => {
            const current = row.document.versions[0];
            const state = row.document.indexManifests[0];
            const indexed = state?.publishedIndexedDocument;
            return {
                documentId: row.documentId,
                name: row.document.name,
                mediaType: current?.mediaType ?? indexed?.mediaType ?? '',
                libraryVersion: current?.version ?? null,
                indexedVersion: indexed?.sourceVersion.version ?? null,
                metadataRevision: row.metadataRevision,
                language: row.language,
                tags: row.tags,
                metadata: documentMetadata.parse(row.metadata),
                pending: Boolean(
                    generation &&
                    (!indexed ||
                        indexed.sourceVersionId !== current?.id ||
                        indexed.metadataRevision !== row.metadataRevision)
                ),
                errorCode: publicIndexFailure(state?.lastErrorCode ?? null),
            };
        }),
    };
}

/** Chunk inspection always requires content reading, including staged chunks visible to a collection manager. */
export async function listIndexChunks(
    context: AuthorizedContext,
    input: Page & {
        documentId?: string;
        publicationId?: string;
    }
) {
    const { actor } = await requireIndexRead(context, input.collectionId);
    const access = await indexCapabilities(context, input.collectionId);
    const where: Prisma.ChunkWhereInput = {
        organizationId: actor.organizationId,
        text: input.query
            ? { contains: input.query, mode: 'insensitive' }
            : undefined,
        indexedDocument: {
            collectionId: input.collectionId,
            ...(input.documentId ? { documentId: input.documentId } : {}),
            ...(input.publicationId ? { id: input.publicationId } : {}),
            status: access.canManage
                ? { in: ['STAGING', 'SEALED', 'PUBLISHED'] }
                : 'PUBLISHED',
            generation: {
                status: { in: ['PROVISIONING', 'BUILDING', 'ACTIVE'] },
            },
            ...(access.canManage
                ? {}
                : {
                      publishedBy: {
                          some: {
                              removedAt: null,
                              generation: {
                                  activeFor: {
                                      some: {
                                          id: input.collectionId,
                                          deletedAt: null,
                                      },
                                  },
                              },
                          },
                      },
                  }),
            sourceVersion: {
                contentState: 'AVAILABLE',
                discardedAt: null,
                document: {
                    deletedAt: null,
                    collections: {
                        some: {
                            collectionId: input.collectionId,
                            organizationId: actor.organizationId,
                        },
                    },
                },
            },
            extraction: { discardedAt: null },
        },
    };
    const [rows, total] = await Promise.all([
        context.db.chunk.findMany({
            where,
            take: input.limit,
            skip: input.offset,
            orderBy: [{ indexedDocumentId: 'asc' }, { ordinal: 'asc' }],
            include: { indexedDocument: { include: { sourceVersion: true } } },
        }),
        context.db.chunk.count({ where }),
    ]);
    await requireIndexRead(context, input.collectionId);
    return {
        total,
        items: rows.map((row) => chunkDto(row, row.indexedDocument)),
    };
}

/** Tombstones remain visible until physical cleanup is confirmed, with a bounded retry entry point. */
export async function listIndexTrash(
    context: AuthorizedContext,
    input: Omit<Page, 'collectionId'>
) {
    const actor = await ragActor(context, context.db, {}, true);
    const where: Prisma.CollectionWhereInput = {
        AND: [
            indexCleanupWhere(actor),
            { name: { contains: input.query, mode: 'insensitive' } },
        ],
    };
    const [rows, total] = await Promise.all([
        context.db.collection.findMany({
            where,
            skip: input.offset,
            take: input.limit,
            orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
        }),
        context.db.collection.count({ where }),
    ]);
    return {
        total,
        items: await Promise.all(
            rows.map(async (row) => ({
                id: row.id,
                name: row.name,
                deletedAt: row.deletedAt!,
                pendingTasks: await context.db.indexTask.count({
                    where: {
                        organizationId: actor.organizationId,
                        collectionId: row.id,
                        status: { in: ['PENDING', 'PROCESSING'] },
                    },
                }),
                failedTasks: await context.db.indexTask.count({
                    where: {
                        organizationId: actor.organizationId,
                        collectionId: row.id,
                        status: 'FAILED',
                    },
                }),
            }))
        ),
    };
}
