import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import type {
    Prisma,
    Chunk,
    IndexedDocument,
    DocumentVersion,
    IndexGenerationStatus,
} from '@repo/db';
import { chunkView } from '@repo/api-contracts/v1/rag/indexing-types';
import { quotaLimits } from '../quotas';
import { ragActor } from '../access';
import { configurationDto } from '../collection-view';
import { projectMetadata } from './metadata-validation';
import {
    indexCapabilities,
    indexCleanupWhere,
    requireIndexDocuments,
    requireIndexRead,
} from './access';
import { publicIndexFailure } from './errors';
import { supportsIndexProfile } from './embedding-profile';

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
export function getIndexStatus(
    context: AuthorizedContext,
    collectionId: string
) {
    return context.db.$transaction(
        (tx) => readIndexStatus(context, collectionId, tx),
        { isolationLevel: 'RepeatableRead' }
    );
}

async function readIndexStatus(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient
) {
    const access = await indexCapabilities(context, collectionId, db);
    const organizationId = access.actor.organizationId;
    const [generations, accounting, limits, configuration] = await Promise.all([
        db.indexGeneration.findMany({
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
        db.collectionIndexAccounting.findUnique({
            where: { collectionId },
        }),
        quotaLimits(db, organizationId),
        db.collectionConfigRevision.findUnique({
            where: {
                ['organizationId_collectionId_revision']: {
                    organizationId,
                    collectionId,
                    revision: access.collection.configurationRevision,
                },
            },
        }),
    ]);
    // A long-lived active generation may be older than ten discarded rebuilds.
    // Keep it in the bounded response even when recent history fills the page.
    if (
        access.collection.activeGenerationId &&
        !generations.some(
            (item) => item.id === access.collection.activeGenerationId
        )
    ) {
        const active = await db.indexGeneration.findFirst({
            where: {
                id: access.collection.activeGenerationId,
                organizationId,
                collectionId,
            },
            include: {
                configuration: true,
                _count: { select: { documents: true } },
            },
        });
        if (active) {
            generations.pop();
            generations.unshift(active);
        }
    }
    const items = await Promise.all(
        generations.map(async (generation) => ({
            id: generation.id,
            status: generation.status,
            configurationRevision: generation.configurationRevision,
            previousGenerationId: generation.previousGenerationId,
            model: generation.configuration.model,
            dimensions: generation.configuration.dimensions,
            modelIdentity: generation.modelIdentity,
            createdAt: generation.createdAt,
            activatedAt: generation.activatedAt,
            retiredAt: generation.retiredAt,
            cleanupAfter: generation.cleanupAfter,
            projectedChunks: Number(generation.projectedChunks),
            totalDocuments: generation._count.documents,
            publishedDocuments: await db.generationDocument.count({
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
    const unsupported = !configuration || !supportsIndexProfile(configuration);
    const candidateStates: IndexGenerationStatus[] = [
        'PROVISIONING',
        'BUILDING',
        'FAILED',
    ];
    const [uncleaned, organizationRebuild] = await Promise.all([
        db.indexGeneration.count({
            where: { organizationId, collectionId, status: { not: 'CLEANED' } },
        }),
        db.indexGeneration.count({
            where: {
                organizationId,
                previousGenerationId: { not: null },
                status: { in: [...candidateStates] },
            },
        }),
    ]);
    const rebuildBlockedReason = unsupported
        ? ('PROFILE_UNSUPPORTED' as const)
        : generations.some((item) => candidateStates.includes(item.status)) ||
            organizationRebuild
          ? ('REBUILD_IN_PROGRESS' as const)
          : uncleaned >= 2 || !access.collection.activeGenerationId
            ? ('GENERATION_CONFLICT' as const)
            : null;
    const activeConfiguration = generations.find(
        (item) => item.id === access.collection.activeGenerationId
    )?.configuration;
    return {
        configurationRevision: access.collection.configurationRevision,
        deletedAt: access.collection.deletedAt,
        canManage: access.canManage,
        canRead: access.canRead,
        canRebuild: access.canRebuild,
        rebuildBlockedReason,
        activeConfiguration: activeConfiguration
            ? configurationDto(activeConfiguration)
            : null,
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
            include: {
                indexedDocument: { select: { documentId: true } },
                generation: {
                    select: { previousGenerationId: true, status: true },
                },
            },
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
                (!(
                    task.generation.previousGenerationId &&
                    ['PROVISIONING', 'BUILDING', 'FAILED'].includes(
                        task.generation.status
                    )
                ) ||
                    ['CLEAN_PUBLICATION', 'CLEAN_GENERATION'].includes(
                        task.kind
                    ) ||
                    access.canRebuild) &&
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
    const profile = await context.db.collectionConfigRevision.findUniqueOrThrow(
        {
            where: {
                ['organizationId_collectionId_revision']: {
                    organizationId: actor.organizationId,
                    collectionId: collection.id,
                    revision: collection.configurationRevision,
                },
            },
            select: { metadataFields: true },
        }
    );
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
                metadata: projectMetadata(profile.metadataFields, row.metadata),
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
        generationId?: string;
    }
) {
    const { actor, collection } = await requireIndexRead(
        context,
        input.collectionId
    );
    const access = await indexCapabilities(context, input.collectionId);
    const selectedId =
        input.generationId ??
        collection.activeGenerationId ??
        (access.canManage
            ? (
                  await context.db.indexGeneration.findFirst({
                      where: {
                          organizationId: actor.organizationId,
                          collectionId: collection.id,
                          status: {
                              in: ['PROVISIONING', 'BUILDING', 'FAILED'],
                          },
                      },
                      orderBy: { createdAt: 'desc' },
                      select: { id: true },
                  })
              )?.id
            : undefined);
    if (selectedId) {
        const selected = await context.db.indexGeneration.findFirst({
            where: {
                id: selectedId,
                organizationId: actor.organizationId,
                collectionId: collection.id,
                status: access.canManage
                    ? { in: ['PROVISIONING', 'BUILDING', 'ACTIVE', 'FAILED'] }
                    : 'ACTIVE',
            },
            select: { id: true },
        });
        if (
            !selected ||
            (!access.canManage && selectedId !== collection.activeGenerationId)
        )
            throw new ORPCError('NOT_FOUND');
    }
    const where: Prisma.ChunkWhereInput = {
        organizationId: actor.organizationId,
        generationId: selectedId ?? '',
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
