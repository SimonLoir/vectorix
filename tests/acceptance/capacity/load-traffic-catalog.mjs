/** Load-only immutable IDs/ranges preload. No canonical text or vector values are loaded here. */
import {
    need,
    id,
    validateIdentity,
    LoadObservationError,
} from './load-observer-core.mjs';
import {
    loadObserverGuard,
    loadObservationPackages,
} from './load-observer-runtime.mjs';
import { observationBinding } from './load-observer-policy.mjs';
export const STATIC_DRAFT_ONLY = false;
/** Bounded per-document pages prevent125k metadata rows from becoming one unbounded ORM read. */
export async function readTrafficCatalog(
    client,
    { state, fixture, input, parseIdentity, now = () => performance.now() }
) {
    validateIdentity(state, fixture);
    const policyBinding = observationBinding(state, fixture, input);
    need(
        fixture.organizationIds.includes(input.organizationId) &&
            id(input.collectionId) &&
            id(input.generationId) &&
            Array.isArray(input.bindings) &&
            input.bindings.length <= 200,
        'LOAD_OBS_CATALOG_SCOPE'
    );
    let begun = false;
    const deadline = now() + 300000;
    const query = async (sql, args) => {
        need(now() <= deadline, 'LOAD_OBS_READ_DEADLINE');
        const result = await client.query(sql, args);
        need(now() <= deadline, 'LOAD_OBS_READ_DEADLINE');
        return result;
    };
    try {
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        begun = true;
        await query("SET LOCAL statement_timeout='10000ms'");
        await query("SET LOCAL lock_timeout='1000ms'");
        const database = (
            await query(
                "SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly"
            )
        ).rows;
        need(
            database.length === 1 &&
                database[0].database === state.applicationDatabase &&
                database[0].readonly === 'on',
            'LOAD_OBS_DATABASE'
        );
        const generations = (
            await query(
                `SELECT g.id,CASE WHEN octet_length(g."capabilitySnapshot"::text)<=16384 THEN g."capabilitySnapshot" END AS identity FROM "IndexGeneration" g JOIN "Collection" c ON c."organizationId"=g."organizationId" AND c.id=g."collectionId" WHERE g.id=$1 AND g."organizationId"=$2 AND g."collectionId"=$3 AND g.status='ACTIVE' AND c."activeGenerationId"=g.id AND c."deletedAt" IS NULL AND g."configurationRevision"=1 AND g."chunkerVersion"='token-window-utf8-v1' AND g."parentContextVersion"='parent-context-utf8-v1'`,
                [input.generationId, input.organizationId, input.collectionId]
            )
        ).rows;
        need(generations.length === 1, 'LOAD_OBS_CATALOG_CURRENT');
        const modelIdentity = parseIdentity(generations[0].identity);
        need(
            modelIdentity.provider === 'OLLAMA' &&
                modelIdentity.digest === state.loadPolicy.model.digest &&
                modelIdentity.dimensions === 768,
            'LOAD_OBS_IDENTITY'
        );
        const documents = (
            await query(
                `SELECT p.id AS "publicationId",p."documentId",p."sourceVersionId" AS "versionId",p."fileName",p."mediaType",p.language,p.tags,CASE WHEN octet_length(p.metadata::text)<=8192 THEN p.metadata END AS metadata,p."documentCreatedAt" AS "createdAt",v.sha256 FROM "GenerationDocument" d JOIN "IndexedDocument" p ON p.id=d."publishedIndexedDocumentId" AND p."organizationId"=d."organizationId" AND p."generationId"=d."generationId" AND p."documentId"=d."documentId" JOIN "DocumentVersion" v ON v.id=p."sourceVersionId" AND v."organizationId"=p."organizationId" AND v."documentId"=p."documentId" WHERE d."organizationId"=$1 AND d."generationId"=$2 AND d."collectionId"=$3 AND d."removedAt" IS NULL AND d."desiredVersionId"=p."sourceVersionId" AND d."desiredExtractionId"=p."extractionId" AND d."desiredMetadataRevision"=p."metadataRevision" AND d."buildRevision"=p."buildRevision" AND p.status='PUBLISHED' AND v.version=1 AND v.status='READY' AND v."contentState"='AVAILABLE' AND v."discardedAt" IS NULL ORDER BY p."documentId" LIMIT 201`,
                [input.organizationId, input.generationId, input.collectionId]
            )
        ).rows;
        need(
            documents.length === input.bindings.length &&
                documents.length <= 200 &&
                new Set(documents.map((row) => row.documentId)).size ===
                    documents.length,
            'LOAD_OBS_CATALOG_BOUND'
        );
        let total = 0;
        for (const document of documents) {
            need(
                document.metadata &&
                    input.bindings.some(
                        (row) =>
                            row.documentId === document.documentId &&
                            row.versionId === document.versionId
                    ),
                'LOAD_OBS_CATALOG_CURRENT'
            );
            const chunks = [];
            let ordinal = -1;
            while (true) {
                const page = (
                    await query(
                        `SELECT id,ordinal,kind,"parentId","startOffset","endOffset","textHash","embeddingInputHash" FROM "Chunk" WHERE "organizationId"=$1 AND "generationId"=$2 AND "indexedDocumentId"=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 500`,
                        [
                            input.organizationId,
                            input.generationId,
                            document.publicationId,
                            ordinal,
                        ]
                    )
                ).rows;
                need(
                    page.length <= 500 && chunks.length + page.length <= 1000,
                    'LOAD_OBS_CATALOG_BOUND'
                );
                chunks.push(...page);
                if (page.length < 500) break;
                ordinal = page.at(-1).ordinal;
            }
            total += chunks.length;
            need(total <= 125000, 'LOAD_OBS_CATALOG_BOUND');
            document.chunks = chunks;
            document.createdAt = new Date(document.createdAt).toISOString();
        }
        await query('COMMIT');
        begun = false;
        return {
            evidenceKind: 'LIVE_READ_ONLY',
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            generationId: input.generationId,
            ...policyBinding,
            modelIdentity,
            documents,
        };
    } finally {
        if (begun) await client.query('ROLLBACK').catch(() => {});
    }
}
/** Guard before package/client construction; the factory cannot execute while its runtime flag is true. */
export async function createTrafficCatalogRuntime({
    state,
    fixture,
    statePath,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    const admit = () => loadObserverGuard({ state, statePath });
    await admit();
    const { Client, embeddings } = await loadObservationPackages(admit);
    return {
        async catalog(input) {
            observationBinding(state, fixture, input);
            await admit();
            const client = new Client({
                connectionString: state.environment.DATABASE_URL,
                connectionTimeoutMillis: 5000,
                query_timeout: 12000,
            });
            try {
                await client.connect();
                return await readTrafficCatalog(client, {
                    state,
                    fixture,
                    input,
                    parseIdentity: (value) =>
                        embeddings.modelIdentity.parse(value),
                });
            } catch (error) {
                if (error instanceof LoadObservationError) throw error;
                throw new LoadObservationError('LOAD_OBS_CATALOG_READ');
            } finally {
                await client.end().catch(() => {});
            }
        },
    };
}
