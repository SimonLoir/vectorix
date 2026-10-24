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
import { resolveIndexChunking } from './generation-profile';
import { publicationFilters, type SearchFilters } from './filters';
import { lexicalSearch } from './lexical';
import { chunkDto } from './views';
import { readProjectedChunks } from './chunk-projection';
import { selectSearchRepresentatives } from './search-representatives';
import { issueSourceReceipt } from './receipts';
import { indexError, safeIndexError } from './errors';
import { SEARCH_DEADLINE_MS } from './source-retention';
import { getRagTelemetry } from '../telemetry';
import { measureTelemetry, telemetryFailure } from '../telemetry/domain';
import type {
    TelemetryExecution,
    TelemetryFailure,
    TelemetryOutcome,
} from '../telemetry/types';

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
    const monotonicStart = performance.now();
    let execution: TelemetryExecution | undefined;
    let closePreflight: (() => void) | undefined,
        closeFusion: (() => void) | undefined;
    let outcome: TelemetryOutcome = 'FAILURE',
        failure: TelemetryFailure | undefined;
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
        const provider =
            input.strategy === 'LEXICAL'
                ? 'NONE'
                : generation.configuration.provider;
        if (provider !== 'S3') {
            execution = getRagTelemetry(context.db).start(
                {
                    organizationId: actor.organizationId,
                    workload:
                        input.strategy === 'LEXICAL'
                            ? 'SEARCH_LEXICAL'
                            : input.strategy === 'VECTOR'
                              ? 'SEARCH_VECTOR'
                              : 'SEARCH_HYBRID',
                    provider,
                },
                monotonicStart
            );
            closePreflight = execution.phase('PREFLIGHT', monotonicStart);
        }
        resolveIndexChunking(
            generation.configuration,
            generation.chunkerVersion,
            generation.parentContextVersion
        );
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
        const parentEnabled = generation.parentContextVersion !== null;
        const candidateLimit = parentEnabled
            ? Math.min(500, Math.max(200, input.topK * 10))
            : Math.min(200, input.topK * 4);
        closePreflight?.();
        const lexicalPromise =
            input.strategy === 'VECTOR' || !publicationIds.length
                ? Promise.resolve([] as { id: string }[])
                : measureTelemetry(execution, 'LEXICAL', () =>
                      lexicalSearch(context.db, {
                          organizationId: actor.organizationId,
                          generationId: generation.id,
                          publicationIds,
                          query: input.query,
                          limit: candidateLimit,
                      })
                  );
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
            const prepared = await measureTelemetry(
                execution,
                'VECTOR',
                async () => {
                    const identity = modelIdentity.parse(
                        generation.capabilitySnapshot
                    );
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
                    return { identity, configuration };
                }
            );
            await context.admitProviderRequest?.();
            const query = await measureTelemetry(execution, 'QUERY_EMBED', () =>
                embedQuery(
                    prepared.configuration,
                    prepared.identity,
                    input.query,
                    {
                        preparation: generation.configuration.preparation,
                        signal: AbortSignal.timeout(SEARCH_DEADLINE_MS),
                        timeoutMs: Math.min(30_000, SEARCH_DEADLINE_MS),
                        numericObserver: execution?.nativeObserver,
                    }
                )
            );
            return await measureTelemetry(execution, 'VECTOR', async () => {
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
            });
        })();
        const [lexicalResult, vectorResult] = await Promise.allSettled([
            lexicalPromise,
            vectorPromise,
        ]);
        closeFusion = execution?.phase('FUSION_HYDRATE');
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
        // Ranking never loads canonical text/provenance. Refresh temporal fences
        // after provider I/O and hydrate only final unique parent representatives.
        const currentWhere = (): Prisma.IndexedDocumentWhereInput => ({
            AND: [
                livePublications(
                    actor.organizationId,
                    collection.id,
                    generation.id
                ),
                filters,
                { id: { in: publicationIds } },
            ],
        });
        const metadata = await context.db.chunk.findMany({
            where: {
                organizationId: actor.organizationId,
                generationId: generation.id,
                kind: 'CHILD',
                id: { in: ranked.map(([id]) => id) },
                indexedDocument: currentWhere(),
            },
            select: { id: true, parentId: true, indexedDocumentId: true },
            take: candidateLimit * 2,
        });
        const selected = selectSearchRepresentatives(
            ranked,
            metadata,
            parentEnabled,
            input.topK
        );
        const chunks = await readProjectedChunks(context.db, {
            organizationId: actor.organizationId,
            generationId: generation.id,
            ids: selected.map(([id]) => id),
            parentEnabled,
        });
        // The exact candidate/association/source fences are current again after
        // context hydration. Never replace the captured generation mid-request.
        const publicationsNow = await context.db.indexedDocument.findMany({
            where: {
                AND: [
                    currentWhere(),
                    {
                        id: { in: chunks.map((row) => row.indexedDocumentId) },
                    },
                ],
            },
            select: {
                id: true,
                documentId: true,
                fileName: true,
                status: true,
                sourceVersionId: true,
                extractionId: true,
                sourceVersion: { select: { version: true } },
                mediaType: true,
                tags: true,
                metadata: true,
            },
            take: input.topK,
        });
        await requireIndexRead(context, collection.id);
        const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        const byPublication = new Map(
            publicationsNow.map((row) => [row.id, row])
        );
        if (Date.now() - startedAt >= SEARCH_DEADLINE_MS)
            throw indexError('PROVIDER_TIMEOUT');
        const results = selected
            .flatMap(([id, scores]) => {
                const chunk = byId.get(id);
                if (!chunk) return [];
                const publication = byPublication.get(chunk.indexedDocumentId);
                if (!publication) return [];
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
        outcome = 'SUCCESS';
        return {
            generationId: generation.id,
            model: generation.configuration.model,
            strategy: input.strategy,
            results,
            vectorUnderfilled: vectorResult.value.underfilled,
            ...(parentEnabled
                ? { parentUnderfilled: results.length < input.topK }
                : {}),
            durationMs: Date.now() - startedAt,
        };
    } catch (error) {
        const safe = safeIndexError(error);
        const code =
            safe.data &&
            typeof safe.data === 'object' &&
            'errorCode' in safe.data
                ? safe.data.errorCode
                : safe.code;
        failure = telemetryFailure(code);
        outcome =
            failure === 'ACCESS' || failure === 'LEASE' ? 'DENIED' : 'FAILURE';
        throw safe;
    } finally {
        closePreflight?.();
        closeFusion?.();
        execution?.finish(outcome, failure);
    }
}
