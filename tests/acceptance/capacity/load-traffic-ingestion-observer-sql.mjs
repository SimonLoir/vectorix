/** Parameterized, bounded read-only traffic snapshots; only generated vector identifiers are interpolated. */
import {
    need,
    INGESTION_LIMITS,
    IngestionObservationError,
} from './load-traffic-ingestion-observer.mjs';
import { same, sha } from './load-observer-core.mjs';
import { validateIngestionInventory } from './load-traffic-ingestion-observer-history.mjs';
export const STATIC_DRAFT_ONLY = true;
const one = (result) => {
    need(result.rows.length === 1, 'LOAD_INGEST_ROW');
    return result.rows[0];
};

/** A shared wall-clock deadline bounds both sequential store transactions, SQL and local re-planning. */
export async function ingestionReadonly(
    client,
    database,
    operation,
    { now = () => performance.now(), deadline = performance.now() + 30000 } = {}
) {
    let begun = false;
    const check = () => need(now() <= deadline, 'LOAD_INGEST_DEADLINE');
    const query = async (...args) => {
        check();
        const result = await client.query(...args);
        check();
        return result;
    };
    try {
        check();
        begun = true;
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await query("SET LOCAL statement_timeout='5000ms'");
        await query("SET LOCAL lock_timeout='1000ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
        const actual = one(
            await query(
                "SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly"
            )
        );
        need(
            actual.database === database && actual.readonly === 'on',
            'LOAD_INGEST_DATABASE'
        );
        const value = await operation({ query, check });
        check();
        await query('COMMIT');
        begun = false;
        return value;
    } finally {
        if (begun) await client.query('ROLLBACK').catch(() => {});
    }
}

const generationSQL = `SELECT g.id,g."organizationId",g."collectionId",g.status,g."configurationRevision",g."vectorSchema",g."tableName",g."destinationFingerprint",g."modelIdentity",g."chunkerVersion",g."parentContextVersion",g."projectedChunks"::text,g."appliedSequence"::text,
 CASE WHEN octet_length(g."capabilitySnapshot"::text)<=16384 THEN g."capabilitySnapshot" END AS identity,
 c."activeGenerationId",c."deletedAt",c."contentSequence"::text,r.provider,r.model,r.dimensions,r.metric,r."indexType",r."numericType",r.endpoint,r.preparation,r."embeddingPreset",r."chunkingStrategy",r.chunking,r."parentChild",r."metadataFields",a."activeChunks"::text,a."retainedChunks"::text,a."reservedChunks"::text
 FROM "IndexGeneration" g JOIN "Collection" c ON c.id=g."collectionId" AND c."organizationId"=g."organizationId" JOIN "CollectionConfigRevision" r ON r."collectionId"=g."collectionId" AND r."organizationId"=g."organizationId" AND r.revision=g."configurationRevision" AND r."vectorConnectionId"=g."vectorConnectionId" JOIN "CollectionIndexAccounting" a ON a."collectionId"=g."collectionId" AND a."organizationId"=g."organizationId" WHERE g.id=$1 AND g."organizationId"=$2 AND g."collectionId"=$3`;
const candidateSQL = `SELECT p.id,p."organizationId",p."generationId",p."documentId",p."sourceVersionId",p."extractionId",p.status,p."chunkCount",p."materializedChunks",p."manifestHash",p."fileName",p."mediaType",p."extractorVersion",p."vectorSealedAt",p."publishedAt",p."metadataRevision",p."buildRevision",p."sourceChangeSequence"::text,p.language,p.tags,p.metadata,
 v.sha256,v.version,v.status AS "sourceStatus",v."contentState" AS "sourceState",v."discardedAt",e."discardedAt" AS "extractionDiscardedAt",h.state AS "holdState",i.status AS "ingestionStatus",i."reservedBytes"::text AS "ingestionReservedBytes"
 FROM "IndexedDocument" p JOIN "DocumentVersion" v ON v.id=p."sourceVersionId" AND v."organizationId"=p."organizationId" AND v."documentId"=p."documentId" JOIN "Document" d ON d.id=v."documentId" AND d."organizationId"=v."organizationId" AND d."deletedAt" IS NULL JOIN "DocumentExtraction" e ON e.id=p."extractionId" AND e."versionId"=v.id AND e."organizationId"=v."organizationId" JOIN "DocumentIngestion" i ON i."organizationId"=v."organizationId" AND i."versionId"=v.id JOIN "DocumentSourceHold" h ON h."indexedDocumentId"=p.id AND h."organizationId"=p."organizationId" AND h."versionId"=v.id WHERE p."organizationId"=$1 AND p."generationId"=$2 ORDER BY p.id LIMIT 65`;
const chunkSQL = `SELECT id,"organizationId","generationId","indexedDocumentId",ordinal,kind,CASE WHEN octet_length(text)<=49152 THEN text END AS text,"textHash","embeddingInputHash","startOffset","endOffset","parentId","tokenCount","tokenCountIsEstimate",jsonb_array_length("sourceSpans") AS "sourceSpanCount",(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM (SELECT value,ord FROM jsonb_array_elements("sourceSpans") WITH ORDINALITY x(value,ord) ORDER BY ord LIMIT 64) bounded) AS "sourceSpans" FROM "Chunk" WHERE "organizationId"=$1 AND "generationId"=$2 ORDER BY "indexedDocumentId",ordinal LIMIT 257`;

/** Separate app/vector snapshots preserve observed cleanup lag, not an atomic cross-store backup claim. */
export async function readIngestionProof(
    app,
    vector,
    { state, input, dependencies, now = () => performance.now() }
) {
    need(
        input.bindings.length <= 6 && input.bindings.length >= 3,
        'LOAD_INGEST_BOUNDS'
    );
    const profile = dependencies.profile(input);
    const budget = { now, deadline: now() + 30000 };
    try {
        return await ingestionReadonly(
            app,
            state.applicationDatabase,
            async (db) =>
                ingestionReadonly(
                    vector,
                    state.vectorDatabase,
                    async (vx) => {
                        const generation = one(
                            await db.query(generationSQL, [
                                input.generationId,
                                input.organizationId,
                                input.collectionId,
                            ])
                        );
                        need(
                            same(
                                Object.fromEntries(
                                    Object.keys(profile).map((key) => [
                                        key,
                                        generation[key],
                                    ])
                                ),
                                profile
                            ) &&
                                generation.status === 'ACTIVE' &&
                                generation.activeGenerationId ===
                                    generation.id &&
                                generation.deletedAt === null &&
                                generation.configurationRevision === 1 &&
                                generation.modelIdentity ===
                                    state.loadPolicy.model.digest &&
                                generation.chunkerVersion ===
                                    'token-window-utf8-v1' &&
                                generation.parentContextVersion ===
                                    'parent-context-utf8-v1' &&
                                generation.endpoint ===
                                    state.environment
                                        .VECTORIX_DEFAULT_OLLAMA_ENDPOINT &&
                                generation.vectorSchema ===
                                    'vector_collections' &&
                                generation.tableName ===
                                    dependencies.generationTable(
                                        generation.id
                                    ) &&
                                generation.appliedSequence ===
                                    generation.contentSequence,
                            'LOAD_INGEST_PROFILE'
                        );
                        const identity = dependencies.identity(
                            generation.identity
                        );
                        need(
                            identity.schemaVersion === 1 &&
                                identity.provider === 'OLLAMA' &&
                                identity.model === 'embeddinggemma:latest' &&
                                identity.digest === generation.modelIdentity &&
                                identity.dimensions === 768 &&
                                identity.preset === 'EMBEDDING_GEMMA',
                            'LOAD_INGEST_MODEL'
                        );
                        const vi = one(
                            await vx.query(
                                'SELECT identity::text,version FROM vector_collections.vx_identity WHERE singleton'
                            )
                        );
                        const url = new URL(
                                state.environment.VECTOR_DATABASE_URL
                            ),
                            fingerprint = sha(
                                JSON.stringify([
                                    url.hostname,
                                    url.port,
                                    decodeURI(url.pathname.slice(1)),
                                    'vector_collections',
                                    'disable',
                                    'postgres',
                                    'false',
                                    false,
                                ]) +
                                    ':' +
                                    vi.identity
                            );
                        need(
                            vi.version === 1 &&
                                fingerprint ===
                                    generation.destinationFingerprint,
                            'LOAD_INGEST_DESTINATION'
                        );
                        const held = one(
                            await vx.query(
                                'SELECT organization_id,collection_id,destination_fingerprint,shape,state FROM vector_collections.vx_generations WHERE id=$1',
                                [generation.id]
                            )
                        );
                        need(
                            held.organization_id === input.organizationId &&
                                held.collection_id === input.collectionId &&
                                held.destination_fingerprint === fingerprint &&
                                held.state === 'READY' &&
                                same(held.shape, {
                                    dimensions: 768,
                                    metric: 'cosine',
                                    indexType: 'DISKANN',
                                    numericType: 'float32',
                                }),
                            'LOAD_INGEST_DESTINATION'
                        );
                        const candidates = (
                            await db.query(candidateSQL, [
                                input.organizationId,
                                input.generationId,
                            ])
                        ).rows;
                        need(
                            candidates.length <= INGESTION_LIMITS.candidates,
                            'LOAD_INGEST_BOUNDS'
                        );
                        const desired = (
                            await db.query(
                                'SELECT "documentId","desiredVersionId","desiredExtractionId","desiredMetadataRevision","desiredChangeSequence"::text,"buildRevision","targetChunkCount","publishedIndexedDocumentId","removedAt" FROM "GenerationDocument" WHERE "organizationId"=$1 AND "generationId"=$2 ORDER BY "documentId" LIMIT 7',
                                [input.organizationId, input.generationId]
                            )
                        ).rows;
                        const associations = (
                            await db.query(
                                'SELECT "documentId","metadataRevision",metadata,language,tags FROM "CollectionDocument" WHERE "organizationId"=$1 AND "collectionId"=$2 ORDER BY "documentId" LIMIT 7',
                                [input.organizationId, input.collectionId]
                            )
                        ).rows;
                        const inventory = one(
                            await db.query(
                                'SELECT (SELECT count(*)::integer FROM "DocumentVersion" v JOIN "CollectionDocument" a ON a."documentId"=v."documentId" AND a."organizationId"=v."organizationId" WHERE a."organizationId"=$1 AND a."collectionId"=$2) AS versions,(SELECT count(*)::integer FROM "IndexGeneration" WHERE "organizationId"=$1 AND "collectionId"=$2) AS generations',
                                [input.organizationId, input.collectionId]
                            )
                        );
                        need(
                            inventory.versions === input.bindings.length &&
                                inventory.generations === 1,
                            'LOAD_INGEST_INVENTORY'
                        );
                        const tasks = (
                            await db.query(
                                'SELECT "organizationId","generationId",kind,status,"indexedDocumentId","reservedChunks",attempts,continuations,"errorCode" FROM "IndexTask" WHERE "organizationId"=$1 AND "generationId"=$2 ORDER BY id LIMIT 257',
                                [input.organizationId, input.generationId]
                            )
                        ).rows;
                        const rows = (
                            await db.query(chunkSQL, [
                                input.organizationId,
                                input.generationId,
                            ])
                        ).rows;
                        const relation =
                            '"vector_collections"."' +
                            generation.tableName +
                            '"'; // Equals the package-generated identifier above, never user input.
                        const physical = (
                            await vx.query(
                                "SELECT chunk_id::text,publication_id::text,source_version_id::text,document_id,generation_id::text,ordinal,chunk_hash,public.vector_dims(embedding) AS dimensions,(public.vector_norm(embedding)>0 AND public.vector_norm(embedding)<'Infinity'::float8) AS finite_nonzero FROM " +
                                    relation +
                                    ' ORDER BY publication_id,ordinal LIMIT 257'
                            )
                        ).rows;
                        const ledgers = (
                            await vx.query(
                                'SELECT id::text,document_id,source_version_id::text,expected_count,manifest_hash,state FROM vector_collections.vx_publications WHERE generation_id=$1 ORDER BY id LIMIT 65',
                                [input.generationId]
                            )
                        ).rows;
                        const plans = [];
                        for (const descriptor of input.descriptors) {
                            db.check();
                            const artifact = dependencies.canonical(descriptor);
                            need(
                                !(artifact instanceof Promise),
                                'LOAD_INGEST_ADAPTER'
                            );
                            need(
                                Buffer.byteLength(artifact.text) <= 2048 &&
                                    artifact.format === 'TEXT',
                                'LOAD_INGEST_SOURCE'
                            );
                            plans.push({
                                artifact,
                                ...dependencies.plan(
                                    artifact,
                                    generation,
                                    identity,
                                    descriptor.fileName
                                ),
                            });
                            db.check();
                        }
                        return validateIngestionInventory({
                            input,
                            generation,
                            candidates,
                            desired,
                            associations,
                            tasks,
                            rows,
                            physical,
                            ledgers,
                            plans,
                            dependencies,
                            identity,
                        });
                    },
                    budget
                ),
            budget
        );
    } catch (error) {
        if (error instanceof IngestionObservationError) throw error;
        throw new IngestionObservationError('LOAD_INGEST_DATABASE');
    }
}
