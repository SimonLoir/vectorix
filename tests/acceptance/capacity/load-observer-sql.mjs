/** Closed read-only PostgreSQL queries. SQL is required for physical tables and bounded JSON projection. */
import {
    need,
    LoadObservationError,
    sha,
    digest,
    fields,
    same,
    OBSERVER_LIMITS,
} from './load-observer-core.mjs';
import {
    validateDocumentLayout,
    generationManifest,
} from './load-observer-layout.mjs';
export const RUNTIME_DRAFT_ONLY = true;
const one = (result) => {
    need(result.rows.length === 1, 'LOAD_OBS_ROW');
    return result.rows[0];
};
async function readonly(
    client,
    database,
    callback,
    budget = {
        now: () => performance.now(),
        deadline: performance.now() + 30000,
    }
) {
    let begun = false;
    try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        begun = true;
        await client.query("SET LOCAL statement_timeout='10000ms'");
        await client.query("SET LOCAL lock_timeout='1000ms'");
        await client.query(
            "SET LOCAL idle_in_transaction_session_timeout='30000ms'"
        );
        const scope = one(
            await client.query(
                "SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly"
            )
        );
        need(
            scope.database === database && scope.readonly === 'on',
            'LOAD_OBS_DATABASE'
        );
        const scoped = {
            query: async (...arguments_) => {
                need(budget.now() <= budget.deadline, 'LOAD_OBS_READ_DEADLINE');
                const result = await client.query(...arguments_);
                need(budget.now() <= budget.deadline, 'LOAD_OBS_READ_DEADLINE');
                return result;
            },
        };
        const value = await callback(scoped);
        need(budget.now() <= budget.deadline, 'LOAD_OBS_READ_DEADLINE');
        await client.query('COMMIT');
        begun = false;
        return value;
    } finally {
        if (begun) await client.query('ROLLBACK').catch(() => {});
    }
}
/** Returns a fixed set of numeric counters, never arbitrary workload/provider labels or tenant inventory. */
export async function readNativeSnapshot(
    client,
    { state, input, producerIdentitySha256 }
) {
    return readonly(client, state.applicationDatabase, async (db) => {
        const aggregate = one(
            await db.query(
                `SELECT count(*)::integer AS count,array_agg("bucketStart" ORDER BY "bucketStart") AS hours,${fields.map((field) => `coalesce(sum("${field}"::numeric),0)::text AS "${field}"`).join(',')} FROM "RagOperationalHour" WHERE "organizationId"=$1 AND workload='INDEX_TOKEN' AND provider='OLLAMA'`,
                [input.organizationId]
            )
        );
        need(aggregate.count <= 720, 'LOAD_OBS_HOUR_BOUND');
        const marker = await db.query(
            'SELECT "formatVersion","knownGapReports"::text FROM "OrganizationRagTelemetry" WHERE "organizationId"=$1',
            [input.organizationId]
        );
        need(
            marker.rows.length <= 1 &&
                (!marker.rows.length || marker.rows[0].formatVersion === 1),
            'LOAD_OBS_MARKER'
        );
        const pending = one(
            await db.query(
                `SELECT count(*)::integer AS count FROM "IndexTask" WHERE "organizationId"=$1 AND kind IN ('PROVISION','INDEX_DOCUMENT') AND status IN ('PENDING','PROCESSING')`,
                [input.organizationId]
            )
        );
        return {
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            producerIdentitySha256,
            knownGapReports: marker.rows[0]?.knownGapReports ?? '0',
            quiescent: pending.count === 0,
            exclusive: pending.count === 0,
            hours: (aggregate.hours ?? []).map((value) =>
                new Date(value).toISOString()
            ),
            counters: Object.fromEntries(
                fields.map((field) => [field, aggregate[field]])
            ),
        };
    });
}
/** Four current scalar progress observations, including zero before initial admission; no history/latency inference. */
export async function readProgressSnapshot(client, { state, fixture, input }) {
    return readonly(client, state.applicationDatabase, async (db) => {
        const row = one(
            await db.query(
                `SELECT c.id,coalesce(a."activeChunks",0)::text AS active,
        (SELECT coalesce(sum(p."materializedChunks"),0)::text FROM "IndexedDocument" p WHERE p."organizationId"=c."organizationId" AND p."collectionId"=c.id AND p.status IN ('STAGING','SEALED','PUBLISHED')) AS materialized,
        (SELECT count(*)::integer FROM "IndexTask" t WHERE t."organizationId"=c."organizationId" AND t."collectionId"=c.id AND t.status IN ('PENDING','PROCESSING')) AS pending,
        (SELECT count(*)::integer FROM "IndexTask" t WHERE t."organizationId"=c."organizationId" AND t."collectionId"=c.id AND t.status='COMPLETE') AS complete
        FROM "Collection" c LEFT JOIN "CollectionIndexAccounting" a ON a."organizationId"=c."organizationId" AND a."collectionId"=c.id WHERE c.id=$1 AND c."organizationId"=ANY($2::text[]) AND c."deletedAt" IS NULL`,
                [input.collectionId, fixture.organizationIds]
            )
        );
        const result = {
            activeChildren: Number(row.active),
            materializedChildren: Number(row.materialized),
            pendingTasks: row.pending,
            completedTasks: row.complete,
        };
        need(
            Object.values(result).every(
                (value) =>
                    Number.isSafeInteger(value) && value >= 0 && value <= 200000
            ),
            'LOAD_OBS_PROGRESS'
        );
        return result;
    });
}
const generationSQL = `SELECT g.id,g."organizationId",g."collectionId",g.status,g."configurationRevision",g."vectorSchema",g."tableName",g."destinationFingerprint",g."modelIdentity",g."chunkerVersion",g."parentContextVersion",g."projectedChunks"::text,g."snapshotSequence"::text,g."appliedSequence"::text,
 CASE WHEN octet_length(g."capabilitySnapshot"::text)<=16384 THEN g."capabilitySnapshot" END AS identity,
 c."activeGenerationId",c."deletedAt",c."contentSequence"::text,r.provider,r.model,r.dimensions,r.metric,r."indexType",r."numericType",r.endpoint,r.preparation,r."embeddingPreset",r."chunkingStrategy",r.chunking,r."parentChild",r."metadataFields",
 a."activeChunks"::text,a."retainedChunks"::text,a."reservedChunks"::text
 FROM "IndexGeneration" g JOIN "Collection" c ON c.id=g."collectionId" AND c."organizationId"=g."organizationId"
 JOIN "CollectionConfigRevision" r ON r."collectionId"=g."collectionId" AND r."organizationId"=g."organizationId" AND r.revision=g."configurationRevision" AND r."vectorConnectionId"=g."vectorConnectionId"
 JOIN "CollectionIndexAccounting" a ON a."collectionId"=g."collectionId" AND a."organizationId"=g."organizationId"
 WHERE g.id=$1 AND g."organizationId"=$2 AND g."collectionId"=$3`;
const documentSQL = `SELECT p.id,p."organizationId",p."generationId",p."documentId",p."sourceVersionId",p."extractionId",p.status,p."chunkCount",p."materializedChunks",p."manifestHash",p."fileName",p."mediaType",p."extractorVersion",p."vectorSealedAt",p."publishedAt",p."metadataRevision",p."buildRevision" AS "candidateBuildRevision",v.sha256,v.version,v.status AS "sourceStatus",v."contentState" AS "sourceState",v."discardedAt",e."discardedAt" AS "extractionDiscardedAt",h.state AS "holdState",d."buildRevision",d."desiredMetadataRevision",d."desiredVersionId",d."desiredExtractionId",d."removedAt"
 FROM "GenerationDocument" d JOIN "IndexedDocument" p ON p.id=d."publishedIndexedDocumentId" AND p."organizationId"=d."organizationId" AND p."generationId"=d."generationId" AND p."documentId"=d."documentId"
 JOIN "DocumentVersion" v ON v.id=p."sourceVersionId" AND v."organizationId"=p."organizationId" AND v."documentId"=p."documentId"
 JOIN "DocumentExtraction" e ON e.id=p."extractionId" AND e."versionId"=v.id AND e."organizationId"=v."organizationId"
 JOIN "DocumentSourceHold" h ON h."indexedDocumentId"=p.id AND h."organizationId"=p."organizationId" AND h."versionId"=v.id
 WHERE d."organizationId"=$1 AND d."generationId"=$2 AND d."documentId">$3 ORDER BY d."documentId" LIMIT 200`;
const chunkSQL = `SELECT id,"organizationId","generationId","indexedDocumentId",ordinal,kind,CASE WHEN octet_length(text)<=49152 THEN text END AS text,"textHash","embeddingInputHash","startOffset","endOffset","parentId","tokenCount","tokenCountIsEstimate",jsonb_array_length("sourceSpans") AS "sourceSpanCount",(SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') FROM (SELECT value,ord FROM jsonb_array_elements("sourceSpans") WITH ORDINALITY x(value,ord) ORDER BY ord LIMIT 64) bounded) AS "sourceSpans" FROM "Chunk" WHERE "organizationId"=$1 AND "generationId"=$2 AND "indexedDocumentId"=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 500`;
/** Consistency is per store. Stable native/current-state checks surround these separate snapshots. */
export async function readGenerationProof(
    app,
    vector,
    { state, input, dependencies }
) {
    const now = dependencies.now ?? (() => performance.now()),
        budget = { now, deadline: now() + 300000 };
    const checkBudget = () =>
        need(now() <= budget.deadline, 'LOAD_OBS_READ_DEADLINE');
    const canonicalWithinBudget = async (...arguments_) => {
        checkBudget();
        let timer;
        try {
            return await Promise.race([
                dependencies.canonical(...arguments_),
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new LoadObservationError(
                                    'LOAD_OBS_READ_DEADLINE'
                                )
                            ),
                        Math.max(1, budget.deadline - now())
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
            checkBudget();
        }
    };
    return readonly(
        app,
        state.applicationDatabase,
        async (db) =>
            readonly(
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
                    const profile = dependencies.profile(input);
                    const saved = Object.fromEntries(
                        Object.keys(profile).map((key) => [
                            key,
                            generation[key],
                        ])
                    );
                    need(
                        same(saved, profile) &&
                            generation.status === 'ACTIVE' &&
                            generation.activeGenerationId === generation.id &&
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
                            generation.vectorSchema === 'vector_collections' &&
                            generation.tableName ===
                                dependencies.generationTable(generation.id) &&
                            generation.appliedSequence ===
                                generation.contentSequence,
                        'LOAD_OBS_PROFILE'
                    );
                    const identity = dependencies.identity(generation.identity);
                    need(
                        identity.schemaVersion === 1 &&
                            identity.provider === 'OLLAMA' &&
                            identity.model === 'embeddinggemma:latest' &&
                            identity.digest === generation.modelIdentity &&
                            identity.dimensions === 768 &&
                            identity.preset === 'EMBEDDING_GEMMA',
                        'LOAD_OBS_IDENTITY'
                    );
                    const vxIdentity = one(
                        await vx.query(
                            'SELECT identity::text,version FROM vector_collections.vx_identity WHERE singleton'
                        )
                    );
                    const url = new URL(state.environment.VECTOR_DATABASE_URL),
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
                                vxIdentity.identity
                        );
                    need(
                        vxIdentity.version === 1 &&
                            fingerprint === generation.destinationFingerprint,
                        'LOAD_OBS_DESTINATION'
                    );
                    const heldGeneration = one(
                        await vx.query(
                            'SELECT organization_id,collection_id,destination_fingerprint,shape,state FROM vector_collections.vx_generations WHERE id=$1',
                            [generation.id]
                        )
                    );
                    need(
                        heldGeneration.organization_id ===
                            input.organizationId &&
                            heldGeneration.collection_id ===
                                input.collectionId &&
                            heldGeneration.destination_fingerprint ===
                                fingerprint &&
                            heldGeneration.state === 'READY' &&
                            same(heldGeneration.shape, {
                                dimensions: 768,
                                metric: 'cosine',
                                indexType: 'DISKANN',
                                numericType: 'float32',
                            }),
                        'LOAD_OBS_DESTINATION'
                    );
                    const relation =
                        '"vector_collections"."' + generation.tableName + '"'; // Generated identifier validated by generationTable equality above.
                    const physicalTotal = one(
                        await vx.query(
                            'SELECT count(*)::integer AS count FROM ' + relation
                        )
                    ).count;
                    need(
                        physicalTotal >= 0 &&
                            physicalTotal <= OBSERVER_LIMITS.children,
                        'LOAD_OBS_PHYSICAL_BOUND'
                    );
                    const inventory = one(
                        await db.query(
                            `SELECT count(*)::integer AS count,count(*) FILTER(WHERE "publishedIndexedDocumentId" IS NOT NULL AND "removedAt" IS NULL)::integer AS published FROM "GenerationDocument" WHERE "organizationId"=$1 AND "generationId"=$2`,
                            [input.organizationId, generation.id]
                        )
                    );
                    need(
                        inventory.count === input.bindings.length &&
                            inventory.published === inventory.count &&
                            inventory.count <= 200,
                        'LOAD_OBS_DOCUMENT_BOUND'
                    );
                    const task = one(
                        await db.query(
                            `SELECT count(*) FILTER(WHERE kind='INDEX_DOCUMENT')::integer AS count,count(*) FILTER(WHERE status!='COMPLETE' OR attempts>1 OR continuations>0 OR "errorCode" IS NOT NULL)::integer AS bad FROM "IndexTask" WHERE "organizationId"=$1 AND "generationId"=$2`,
                            [input.organizationId, generation.id]
                        )
                    );
                    need(
                        task.count === input.bindings.length && task.bad === 0,
                        'LOAD_OBS_TASK'
                    );
                    const publications = [];
                    let cursor = '',
                        preparedBytes = 0,
                        estimatedInputTokens = 0,
                        physicalChildren = 0,
                        parents = 0;
                    do {
                        const page = (
                            await db.query(documentSQL, [
                                input.organizationId,
                                generation.id,
                                cursor,
                            ])
                        ).rows;
                        need(page.length <= 200, 'LOAD_OBS_PAGE');
                        for (const candidate of page) {
                            checkBudget();
                            need(
                                candidate.documentId > cursor &&
                                    candidate.desiredVersionId ===
                                        candidate.sourceVersionId &&
                                    candidate.desiredExtractionId ===
                                        candidate.extractionId &&
                                    candidate.removedAt === null &&
                                    candidate.desiredMetadataRevision ===
                                        candidate.metadataRevision &&
                                    candidate.candidateBuildRevision ===
                                        candidate.buildRevision,
                                'LOAD_OBS_CURRENT'
                            );
                            cursor = candidate.documentId;
                            const index = input.bindings.findIndex(
                                    (binding) =>
                                        binding.documentId ===
                                        candidate.documentId
                                ),
                                binding = input.bindings[index],
                                descriptor = input.descriptors[index];
                            need(
                                binding &&
                                    descriptor &&
                                    binding.versionId ===
                                        candidate.sourceVersionId,
                                'LOAD_OBS_SOURCE'
                            );
                            const artifact = await canonicalWithinBudget(
                                descriptor,
                                candidate.extractorVersion
                            );
                            need(
                                Buffer.byteLength(artifact.text) <=
                                    OBSERVER_LIMITS.sourceBytes,
                                'LOAD_OBS_SOURCE_BOUND'
                            );
                            const planned = dependencies.plan(
                                    artifact,
                                    generation,
                                    identity,
                                    candidate.fileName
                                ),
                                rows = [];
                            checkBudget();
                            let ordinal = -1;
                            do {
                                const next = (
                                    await db.query(chunkSQL, [
                                        input.organizationId,
                                        generation.id,
                                        candidate.id,
                                        ordinal,
                                    ])
                                ).rows;
                                need(
                                    next.length <= 500 &&
                                        rows.length + next.length <= 1000,
                                    'LOAD_OBS_PAGE'
                                );
                                rows.push(...next);
                                if (!next.length) break;
                                ordinal = next.at(-1).ordinal;
                            } while (rows.length < 1000);
                            need(
                                rows.length ===
                                    planned.children.length +
                                        planned.parents.length &&
                                    rows.every(
                                        (row) => row.sourceSpanCount <= 64
                                    ),
                                'LOAD_OBS_LAYOUT_BOUND'
                            );
                            const physical = [];
                            let nextOrdinal = -1;
                            do {
                                const next = (
                                    await vx.query(
                                        "SELECT chunk_id::text,publication_id::text,source_version_id::text,document_id,generation_id::text,ordinal,chunk_hash,public.vector_dims(embedding) AS dimensions,(public.vector_norm(embedding)>0 AND public.vector_norm(embedding)<'Infinity'::float8) AS finite_nonzero FROM " +
                                            relation +
                                            ' WHERE publication_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 500',
                                        [candidate.id, nextOrdinal]
                                    )
                                ).rows;
                                need(
                                    next.length <= 500 &&
                                        physical.length + next.length <= 500,
                                    'LOAD_OBS_PAGE'
                                );
                                physical.push(...next);
                                if (!next.length) break;
                                nextOrdinal = next.at(-1).ordinal;
                            } while (physical.length < 500);
                            const held = one(
                                await vx.query(
                                    'SELECT document_id,source_version_id::text,expected_count,manifest_hash,state FROM vector_collections.vx_publications WHERE generation_id=$1 AND id=$2',
                                    [generation.id, candidate.id]
                                )
                            );
                            const proof = validateDocumentLayout({
                                candidate,
                                descriptor,
                                artifact,
                                ...planned,
                                rows,
                                physical,
                                ledger: held,
                                prepare: dependencies.prepare,
                                manifestHash: dependencies.manifestHash,
                                identity,
                            });
                            checkBudget();
                            publications.push(proof);
                            physicalChildren += proof.childCount;
                            parents += proof.parentCount;
                            preparedBytes += proof.preparedBytes;
                            estimatedInputTokens += proof.estimatedInputTokens;
                        }
                        if (page.length < 200) break;
                    } while (publications.length <= 200);
                    need(
                        publications.length === input.bindings.length &&
                            physicalTotal === physicalChildren &&
                            generation.projectedChunks ===
                                String(physicalChildren) &&
                            generation.activeChunks ===
                                String(physicalChildren) &&
                            generation.retainedChunks === '0' &&
                            generation.reservedChunks === '0',
                        'LOAD_OBS_ACCOUNTING'
                    );
                    return {
                        generationId: generation.id,
                        modelIdentity: generation.modelIdentity,
                        dimensions: 768,
                        chunkerVersion: generation.chunkerVersion,
                        parentContextVersion: generation.parentContextVersion,
                        profileMatches: true,
                        endpointIsOwned: true,
                        quiescent: true,
                        allCanonicalGeometryVerified: true,
                        allPreparedInputHashesVerified: true,
                        allPhysicalManifestRowsVerified: true,
                        activeSourceVersionTuplesVerified: true,
                        physicalChildren,
                        parents,
                        manifestSha256: generationManifest(publications),
                        publications: publications.map(
                            ({
                                preparedBytes,
                                estimatedInputTokens,
                                ...proof
                            }) => proof
                        ),
                        preparedBytes,
                        estimatedInputTokens,
                    };
                },
                budget
            ),
        budget
    );
}
