import { Prisma, type Collection } from '@repo/db';
import {
    isPendingRebuild,
    synchronizationAuthorityState,
    type SynchronizationGeneration,
} from './sync-authority';
import { indexError } from './errors';

type SynchronizationAccess = {
    collection: Pick<Collection, 'id' | 'activeGenerationId' | 'deletedAt'>;
    canManage: boolean;
    canRebuild: boolean;
    actorUserId: string | null;
};

/** A historical retired table is never an actionable synchronization target. */
export function isCurrentSynchronizationGeneration(
    generation: SynchronizationGeneration,
    collection: SynchronizationAccess['collection']
) {
    if (collection.deletedAt) return false;
    return generation.status === 'ACTIVE'
        ? generation.id === collection.activeGenerationId
        : ['PROVISIONING', 'BUILDING', 'FAILED'].includes(generation.status) &&
              generation.previousGenerationId === collection.activeGenerationId;
}

/**
 * Prisma cannot compare desired fields against related publication/candidate
 * columns. This static, scoped SQL selects metadata only; the caller bounds the
 * generation IDs and, for document pages, the document IDs before execution.
 */
function desiredSnapshots(
    organizationId: string,
    collectionId: string,
    generationIds: string[],
    documentIds?: string[]
) {
    return Prisma.sql`
        SELECT desired."generationId", desired."documentId",
               version.version AS "desiredVersion", candidate.id AS "candidateId",
               candidate."createdAt" AS "candidateCreatedAt",
               CASE WHEN published.status='PUBLISHED' THEN published."publishedAt" END AS "indexedAt",
               (generation.status<>'ACTIVE' OR collection."activeGenerationId" IS DISTINCT FROM generation.id
                OR published.id IS NULL OR published.status<>'PUBLISHED' OR published."publishedAt" IS NULL
                OR published."sourceVersionId" IS DISTINCT FROM desired."desiredVersionId"
                OR published."extractionId" IS DISTINCT FROM desired."desiredExtractionId"
                OR published."metadataRevision" IS DISTINCT FROM desired."desiredMetadataRevision"
                OR published."buildRevision" IS DISTINCT FROM desired."buildRevision"
                OR published."sourceChangeSequence" IS DISTINCT FROM desired."desiredChangeSequence") AS pending
        FROM "GenerationDocument" desired
        JOIN "IndexGeneration" generation ON generation.id=desired."generationId"
            AND generation."organizationId"=desired."organizationId" AND generation."collectionId"=desired."collectionId"
        JOIN "Collection" collection ON collection.id=desired."collectionId"
            AND collection."organizationId"=desired."organizationId" AND collection."deletedAt" IS NULL
        JOIN "Document" document ON document.id=desired."documentId"
            AND document."organizationId"=desired."organizationId" AND document."deletedAt" IS NULL
        JOIN "CollectionDocument" association ON association."organizationId"=desired."organizationId"
            AND association."collectionId"=desired."collectionId" AND association."documentId"=desired."documentId"
        LEFT JOIN "IndexedDocument" published ON published.id=desired."publishedIndexedDocumentId"
            AND published."organizationId"=desired."organizationId" AND published."generationId"=desired."generationId"
            AND published."documentId"=desired."documentId"
        LEFT JOIN "IndexedDocument" candidate ON candidate."organizationId"=desired."organizationId"
            AND candidate."generationId"=desired."generationId" AND candidate."documentId"=desired."documentId"
            AND candidate."buildRevision"=desired."buildRevision"
            AND candidate."sourceVersionId"=desired."desiredVersionId"
            AND candidate."extractionId"=desired."desiredExtractionId"
            AND candidate."metadataRevision"=desired."desiredMetadataRevision"
            AND candidate."sourceChangeSequence"=desired."desiredChangeSequence"
            AND candidate.status IN ('STAGING','SEALED','PUBLISHED')
        LEFT JOIN "DocumentVersion" version ON version.id=desired."desiredVersionId"
            AND version."organizationId"=desired."organizationId" AND version."documentId"=desired."documentId"
        WHERE desired."organizationId"=${organizationId} AND desired."collectionId"=${collectionId}
            AND desired."generationId" IN (${Prisma.join(generationIds)})
            AND desired."removedAt" IS NULL AND desired."desiredVersionId" IS NOT NULL
            AND desired."desiredExtractionId" IS NOT NULL
            ${documentIds ? Prisma.sql`AND desired."documentId" IN (${Prisma.join(documentIds)})` : Prisma.empty}
    `;
}

interface GenerationProgress {
    generationId: string;
    pendingDocuments: number;
    blockedTasks: number;
    oldestPendingAt: Date | null;
    lastPublishedAt: Date | null;
}

/** Aggregate at most two live tables; published build candidates remain pending until their generation actually serves searches. */
async function generationProgress(
    db: Prisma.TransactionClient,
    generations: SynchronizationGeneration[]
) {
    const first = generations[0];
    if (!first) return new Map<string, GenerationProgress>();
    const ids = generations.map((generation) => generation.id);
    const rows = await db.$queryRaw<GenerationProgress[]>(Prisma.sql`
        WITH current_desired AS (${desiredSnapshots(first.organizationId, first.collectionId, ids)}),
        documents AS (
            SELECT "generationId", count(*) FILTER (WHERE pending)::integer AS "pendingDocuments",
                   min("candidateCreatedAt") FILTER (WHERE pending) AS "oldestPendingAt"
            FROM current_desired GROUP BY "generationId"
        ), blocked AS (
            SELECT task."generationId", count(*)::integer AS "blockedTasks"
            FROM "IndexTask" task JOIN "IndexGeneration" generation ON generation.id=task."generationId"
                AND generation."organizationId"=task."organizationId" AND generation."collectionId"=task."collectionId"
            WHERE task."organizationId"=${first.organizationId} AND task."collectionId"=${first.collectionId}
                AND task."generationId" IN (${Prisma.join(ids)}) AND task.status='FAILED'
                AND ((task.kind='INDEX_DOCUMENT' AND EXISTS (
                    SELECT 1 FROM current_desired current WHERE current."generationId"=task."generationId"
                        AND current."candidateId"=task."indexedDocumentId"
                )) OR (task.kind='PROVISION' AND task."indexedDocumentId" IS NULL AND generation.status<>'ACTIVE'))
            GROUP BY task."generationId"
        ), publications AS (
            SELECT "generationId", max("publishedAt") AS "lastPublishedAt" FROM "IndexedDocument"
            WHERE "organizationId"=${first.organizationId} AND "collectionId"=${first.collectionId}
                AND "generationId" IN (${Prisma.join(ids)}) AND "publishedAt" IS NOT NULL
            GROUP BY "generationId"
        )
        SELECT generation.id AS "generationId", coalesce(documents."pendingDocuments",0) AS "pendingDocuments",
               coalesce(blocked."blockedTasks",0) AS "blockedTasks", documents."oldestPendingAt", publications."lastPublishedAt"
        FROM "IndexGeneration" generation LEFT JOIN documents ON documents."generationId"=generation.id
        LEFT JOIN blocked ON blocked."generationId"=generation.id
        LEFT JOIN publications ON publications."generationId"=generation.id
        WHERE generation."organizationId"=${first.organizationId} AND generation."collectionId"=${first.collectionId}
            AND generation.id IN (${Prisma.join(ids)})
    `);
    return new Map(rows.map((row) => [row.generationId, row]));
}

/** Metadata does not reveal member identities to readers or API keys, and never grants collection content access. */
export async function liveGenerationSynchronization(
    db: Prisma.TransactionClient,
    generations: SynchronizationGeneration[],
    access: SynchronizationAccess
) {
    const live = generations.filter((generation) =>
        isCurrentSynchronizationGeneration(generation, access.collection)
    );
    if (live.length > 2) throw indexError('GENERATION_CONFLICT');
    const progress = await generationProgress(db, live);
    return new Map(
        await Promise.all(
            live.map(async (generation) => {
                const observed = progress.get(generation.id);
                return [
                    generation.id,
                    {
                        ...(access.canManage
                            ? { authorityUserId: generation.authorityUserId }
                            : {}),
                        authorityState: await synchronizationAuthorityState(
                            db,
                            generation
                        ),
                        isCurrentUser:
                            access.actorUserId !== null &&
                            generation.authorityUserId === access.actorUserId,
                        canAdopt:
                            access.canManage &&
                            (!isPendingRebuild(generation) ||
                                access.canRebuild),
                        pendingDocuments: observed?.pendingDocuments ?? 0,
                        blockedTasks: observed?.blockedTasks ?? 0,
                        oldestPendingAt: observed?.oldestPendingAt ?? null,
                        lastPublishedAt: observed?.lastPublishedAt ?? null,
                    },
                ] as const;
            })
        )
    );
}

export interface DocumentFreshness {
    documentId: string;
    desiredVersion: number | null;
    indexedAt: Date | null;
    pendingSince: Date | null;
    freshness: 'NOT_INDEXED' | 'CURRENT' | 'PENDING' | 'BLOCKED';
    retryTaskId: string | null;
}

/**
 * Enrich only one already-authorized document page. Failed tasks must belong to
 * its exact current candidate; superseded errors cannot become recovery targets.
 * CURRENT requires the active serving pointer, not only a published build row.
 * The caller masks retry IDs using freshly checked session/rebuild capabilities.
 */
export async function documentFreshness(
    db: Prisma.TransactionClient,
    input: {
        organizationId: string;
        collectionId: string;
        generationId: string;
        documentIds: string[];
    }
) {
    if (!input.documentIds.length) return new Map<string, DocumentFreshness>();
    if (input.documentIds.length > 100) throw indexError('CHUNK_LIMIT');
    const rows = await db.$queryRaw<DocumentFreshness[]>(Prisma.sql`
        WITH current_desired AS (${desiredSnapshots(input.organizationId, input.collectionId, [input.generationId], input.documentIds)})
        SELECT current."documentId", current."desiredVersion", current."indexedAt",
               CASE WHEN current.pending THEN current."candidateCreatedAt" END AS "pendingSince",
               CASE WHEN failed.id IS NOT NULL THEN 'BLOCKED'
                    WHEN NOT current.pending THEN 'CURRENT' ELSE 'PENDING' END AS freshness,
               failed.id AS "retryTaskId"
        FROM current_desired current LEFT JOIN LATERAL (
            SELECT task.id FROM "IndexTask" task
            WHERE task."organizationId"=${input.organizationId} AND task."collectionId"=${input.collectionId}
                AND task."generationId"=${input.generationId} AND task."indexedDocumentId"=current."candidateId"
                AND task.kind='INDEX_DOCUMENT' AND task.status='FAILED'
            ORDER BY task."createdAt" DESC, task.id DESC LIMIT 1
        ) failed ON true
    `);
    return new Map(rows.map((row) => [row.documentId, row]));
}
