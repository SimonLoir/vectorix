import type { AuthorizedContext } from '@routers/utils/authorized';
import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { embedQuery, modelIdentity } from '@repo/embeddings';
import { documentMetadata } from '@repo/api-contracts/v1/rag/indexing-types';
import { requireIndexRead } from './access';
import {
    boundEmbeddingConfiguration,
    matchesEmbeddingIdentity,
} from './embedding-profile';
import { generationVectorAdapter } from './generation-adapter';
import { publicationFilters, type SearchFilters } from './filters';
import { lexicalSearch } from './lexical';
import { chunkDto } from './views';
import { issueSourceReceipt } from './receipts';
import { indexError, safeIndexError } from './errors';
import { SEARCH_DEADLINE_MS } from './source-retention';

type Input = {
    collectionId: string;
    query: string;
    topK: number;
    strategy: 'HYBRID' | 'LEXICAL' | 'VECTOR';
    filters: SearchFilters;
};

/** Only exact, live catalog publications are eligible; the vector store never supplies authorization or canonical text. */
function livePublications(
    organizationId: string,
    collectionId: string,
    generationId: string
): Prisma.IndexedDocumentWhereInput {
    return {
        organizationId,
        collectionId,
        generationId,
        status: 'PUBLISHED',
        publishedBy: {
            some: { organizationId, generationId, removedAt: null },
        },
        sourceVersion: {
            contentState: 'AVAILABLE',
            discardedAt: null,
            document: {
                organizationId,
                deletedAt: null,
                collections: { some: { organizationId, collectionId } },
            },
        },
        extraction: { discardedAt: null },
        sourceHold: {
            OR: [
                { state: 'LIVE' },
                { state: 'RETIRED', retainUntil: { gt: new Date() } },
            ],
        },
        generation: {
            OR: [
                { status: 'ACTIVE' },
                { status: 'RETIRED', cleanupAfter: { gt: new Date() } },
            ],
        },
    };
}

/**
 * Capture one active generation, filter before both ranking branches, fuse ranks,
 * then recheck grants/live publications after provider I/O. A failed required
 * branch is an explicit error, never a silently degraded hybrid response.
 */
export async function searchCollection(
    context: AuthorizedContext,
    input: Input
) {
    const startedAt = Date.now();
    try {
        const { actor, collection } = await requireIndexRead(
            context,
            input.collectionId
        );
        const generation = await context.db.indexGeneration.findFirst({
            where: {
                id: collection.activeGenerationId ?? '',
                organizationId: actor.organizationId,
                collectionId: collection.id,
                status: 'ACTIVE',
            },
            include: { configuration: true },
        });
        if (!generation) throw indexError('SOURCE_UNAVAILABLE');
        const filters = publicationFilters(
            generation.configuration.metadataFields,
            input.filters
        );
        if (input.filters.documentIds?.length) {
            const ids = [...new Set(input.filters.documentIds)];
            if (
                (await context.db.collectionDocument.count({
                    where: {
                        organizationId: actor.organizationId,
                        collectionId: collection.id,
                        documentId: { in: ids },
                        document: { deletedAt: null },
                    },
                })) !== ids.length
            )
                throw new ORPCError('BAD_REQUEST');
        }
        const where: Prisma.IndexedDocumentWhereInput = {
            AND: [
                livePublications(
                    actor.organizationId,
                    collection.id,
                    generation.id
                ),
                filters,
            ],
        };
        const publications = await context.db.indexedDocument.findMany({
            where,
            select: { id: true },
            take: 5001,
            orderBy: { id: 'asc' },
        });
        if (publications.length > 5000) throw indexError('CHUNK_LIMIT');
        const publicationIds = publications.map((item) => item.id);
        const candidateLimit = Math.min(200, input.topK * 4);
        const lexicalPromise =
            input.strategy === 'VECTOR'
                ? Promise.resolve([] as { id: string }[])
                : lexicalSearch(context.db, {
                      organizationId: actor.organizationId,
                      generationId: generation.id,
                      publicationIds,
                      query: input.query,
                      limit: candidateLimit,
                  });
        const vectorPromise = (async () => {
            if (input.strategy === 'LEXICAL' || !publicationIds.length)
                return {
                    hits: [] as {
                        chunkId: string;
                        publicationId: string;
                        distance: number;
                    }[],
                    underfilled: false,
                };
            const identity = modelIdentity.parse(generation.capabilitySnapshot);
            if (
                !matchesEmbeddingIdentity(
                    identity,
                    generation.configuration,
                    generation.modelIdentity
                )
            )
                throw indexError('MODEL_CHANGED');
            const configuration = await boundEmbeddingConfiguration(
                context.db,
                actor.organizationId,
                collection.id,
                generation.configurationRevision
            );
            const query = await embedQuery(
                configuration,
                identity,
                input.query,
                {
                    preparation: generation.configuration.preparation,
                    signal: AbortSignal.timeout(SEARCH_DEADLINE_MS),
                    timeoutMs: Math.min(30_000, SEARCH_DEADLINE_MS),
                }
            );
            const { store, spec } = await generationVectorAdapter(
                context.db,
                actor.organizationId,
                generation.id
            );
            return await store.search(spec, {
                vector: query.vectors[0]!,
                allowedPublicationIds: publicationIds,
                limit: candidateLimit,
                mode: generation.projectedChunks <= 1000n ? 'exact' : 'ann',
            });
        })();
        const [lexicalResult, vectorResult] = await Promise.allSettled([
            lexicalPromise,
            vectorPromise,
        ]);
        if (lexicalResult.status === 'rejected') throw lexicalResult.reason;
        if (vectorResult.status === 'rejected') throw vectorResult.reason;
        if (Date.now() - startedAt > SEARCH_DEADLINE_MS)
            throw indexError('PROVIDER_TIMEOUT');
        const ranks = new Map<
            string,
            {
                rrf: number;
                lexicalRank: number | null;
                vectorRank: number | null;
                vectorDistance: number | null;
            }
        >();
        for (const [index, row] of lexicalResult.value.entries())
            ranks.set(row.id, {
                rrf: 1 / (60 + index + 1),
                lexicalRank: index + 1,
                vectorRank: null,
                vectorDistance: null,
            });
        for (const [index, row] of vectorResult.value.hits.entries()) {
            const current = ranks.get(row.chunkId) ?? {
                rrf: 0,
                lexicalRank: null,
                vectorRank: null,
                vectorDistance: null,
            };
            ranks.set(row.chunkId, {
                ...current,
                rrf: current.rrf + 1 / (60 + index + 1),
                vectorRank: index + 1,
                vectorDistance: row.distance,
            });
        }
        const ranked = [...ranks].toSorted(
            ([leftId, left], [rightId, right]) =>
                right.rrf - left.rrf || leftId.localeCompare(rightId)
        );
        await requireIndexRead(context, collection.id);
        // Hydration revalidates exact captured publications and current associations;
        // concurrent replacement may remove a hit, but never introduces another generation.
        const chunks = await context.db.chunk.findMany({
            where: {
                organizationId: actor.organizationId,
                generationId: generation.id,
                kind: 'CHILD',
                id: { in: ranked.map(([id]) => id) },
                indexedDocument: {
                    AND: [
                        where,
                        {
                            id: { in: publicationIds },
                            generation: {
                                status: { in: ['ACTIVE', 'RETIRED'] },
                            },
                        },
                    ],
                },
            },
            include: { indexedDocument: { include: { sourceVersion: true } } },
        });
        await requireIndexRead(context, collection.id);
        const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        if (Date.now() - startedAt >= SEARCH_DEADLINE_MS)
            throw indexError('PROVIDER_TIMEOUT');
        const results = ranked
            .flatMap(([id, scores]) => {
                const chunk = byId.get(id);
                if (!chunk) return [];
                const publication = chunk.indexedDocument;
                return [
                    {
                        ...chunkDto(chunk, publication),
                        mediaType: publication.mediaType,
                        tags: publication.tags,
                        metadata: documentMetadata.parse(publication.metadata),
                        scores,
                        source: issueSourceReceipt({
                            organizationId: actor.organizationId,
                            collectionId: collection.id,
                            generationId: generation.id,
                            publicationId: publication.id,
                            chunkId: chunk.id,
                            versionId: publication.sourceVersionId,
                            extractionId: publication.extractionId,
                        }),
                    },
                ];
            })
            .slice(0, input.topK);
        if (Date.now() - startedAt >= SEARCH_DEADLINE_MS)
            throw indexError('PROVIDER_TIMEOUT');
        return {
            generationId: generation.id,
            model: generation.configuration.model,
            strategy: input.strategy,
            results,
            vectorUnderfilled: vectorResult.value.underfilled,
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        throw safeIndexError(error);
    }
}
