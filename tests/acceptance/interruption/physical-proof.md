# Minimal physical reconciliation for one semantic rebuild

Prepared from the current Prisma catalog, `packages/vector-store/src/{validation,provision,publications}.ts` and the existing quality reader. The historical version of these two fixed SQL templates was executed before and after recovery in run `8af698331852`. The resulting supplemental physical proof is recorded in [the acceptance guide](../../../docs/rag-interruption-acceptance.md). This is a finite read-only recipe, not an automatically executed test.

Use the already admitted fresh topology and its existing ownership/pin/schema/process guard. At recovery use the normal quality guard with the new owned worker; while the old worker is absent use only the separately reviewed absence admission. Call `q.db_query(state, sql)` for the app database and `q.db_query(state, sql, service='vector')` for the exact enrolled vector container/database. That reader uses a read-only transaction default and a 10-second statement timeout. Do not use a DSN or identifier from a response alone.

## Scope and quoting

Take exactly `organizationId`, `collectionId`, `documentId`, A and B generation IDs from the enrolled scope. Before inserting them into this fixed SQL, require every value to match `[A-Za-z0-9_-]{1,128}`; require generation IDs to be lowercase canonical UUIDs and A != B. These limited strings contain no SQL quotes. Never interpolate arbitrary SQL fragments.

Require every returned generation's schema to equal the enrolled `VECTOR_DATABASE_SCHEMA` (`vector_collections` here), and its table name to equal `g_` + its UUID with hyphens removed. Require schema/table names to match `[a-z_][a-z0-9_]{0,62}` and quote each separately with double quotes. This mirrors production `generationTable` and `identifier`. Do not use a caller-supplied table name.

The following templates use `{ORG}`, `{COL}`, `{DOC}`, `{A}`, `{B}` only after these checks. `{SCHEMA}` and `{TABLE}` are separately double-quoted validated identifiers.

## 1. Application catalog snapshot

Run this once before and once after the vector reads; require exact equality of both results. The query returns no document text, credentials, lease tokens, source spans or raw checkpoint/vector values. Each array has a count and an overflow row. Reject more than two generations, four publications or 640 combined child/parent rows; do not truncate and then claim equality.

```sql
SELECT snapshot FROM (WITH
g AS (
  SELECT g.id,g.status,g."previousGenerationId",g."vectorSchema",g."tableName",
    g."destinationFingerprint",g."modelIdentity",g."configurationRevision",
    g."chunkerVersion",g."parentContextVersion",g."activatedAt",g."retiredAt",g."cleanupAfter",
    r.dimensions,r.provider,r.model,r."embeddingPreset",r."parentChild",
    r."indexType",r.metric,r."numericType"
  FROM public."IndexGeneration" g JOIN public."CollectionConfigRevision" r
    ON (r."organizationId",r."collectionId",r.revision,r."vectorConnectionId") =
       (g."organizationId",g."collectionId",g."configurationRevision",g."vectorConnectionId")
  WHERE g."organizationId"='{ORG}' AND g."collectionId"='{COL}'
),
p AS (
  SELECT p.id,p."generationId",p."documentId",p."sourceVersionId",p."extractionId",
    p.status,p."buildRevision",p."metadataRevision",p."sourceChangeSequence"::text,
    p.language,md5(p.metadata::text) AS "metadataMd5",p.tags,
    p."chunkCount",p."materializedChunks",p."manifestHash",p."vectorSealedAt",p."publishedAt"
  FROM public."IndexedDocument" p WHERE p."organizationId"='{ORG}' AND p."collectionId"='{COL}'
),
c AS (
  SELECT c.id,c."generationId",c."indexedDocumentId",c.ordinal,c.kind,c."parentId",
    c."textHash",c."embeddingInputHash",c."startOffset",c."endOffset",c."tokenCount",
    c."tokenCountIsEstimate",c.language
  FROM public."Chunk" c JOIN p ON p.id=c."indexedDocumentId" AND p."generationId"=c."generationId"
  WHERE c."organizationId"='{ORG}'
)
SELECT json_build_object(
  'globalDocuments',(SELECT count(*) FROM public."Document"),
  'globalCollections',(SELECT count(*) FROM public."Collection"),
  'active',(SELECT "activeGenerationId" FROM public."Collection" WHERE "organizationId"='{ORG}' AND id='{COL}' AND "deletedAt" IS NULL),
  'counts',json_build_object('generations',(SELECT count(*) FROM g),'publications',(SELECT count(*) FROM p),'chunks',(SELECT count(*) FROM c)),
  'generations',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM g ORDER BY id LIMIT 3) x),'[]'::json),
  'publications',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM p ORDER BY id LIMIT 5) x),'[]'::json),
  'chunks',COALESCE((SELECT json_agg(row_to_json(x)) FROM (SELECT * FROM c ORDER BY "generationId","indexedDocumentId",ordinal LIMIT 641) x),'[]'::json),
  'pointers',COALESCE((SELECT json_agg(row_to_json(x)) FROM (
    SELECT "generationId","documentId","desiredVersionId","desiredExtractionId","desiredMetadataRevision",
      "desiredChangeSequence"::text,"buildRevision","targetChunkCount","publishedIndexedDocumentId","removedAt"
    FROM public."GenerationDocument" WHERE "organizationId"='{ORG}' AND "collectionId"='{COL}'
    ORDER BY "generationId","documentId" LIMIT 3) x),'[]'::json)
) AS snapshot) AS one_snapshot
```

Require global documents/collections = 1/1, exact generation IDs `{A,B}`, every publication and pointer's document = DOC, exactly one publication and pointer per generation, and no unexpected retained candidates. This deliberate fresh fixture restriction keeps the proof small. A is `RETIRED`, B is `ACTIVE`, B.previousGenerationId = A, the collection pointer is B, and A's cleanup grace has not expired. Both generations have the enrolled model identity, dimensions and parent context version.

For each generation, its pointer resolves its sole publication. The desired source/extraction/metadata/build/sequence tuple must equal that publication; `removedAt` is null. Its publication is `PUBLISHED`, has a real publication time, manifest and vector seal, and its searchable child count equals `chunkCount`, `materializedChunks` and `targetChunkCount`. Generation retirement does not require changing the publication's status. Token counts/estimates and metadata live in this application snapshot, not the vector table.

## 2. Physical snapshot for each validated generation table

Run the same template separately for A and B, substituting `{GEN}` with its validated UUID. Include every row in the table, so a wrong document/publication cannot hide behind a filter. Reject `rowCount > 640` or a truncated array. The exact table must exist as an ordinary table and `embedding` must have the saved `vector(N)` type.

```sql
SELECT json_build_object(
  'ledger',(SELECT row_to_json(x) FROM (SELECT id,organization_id,collection_id,destination_fingerprint,shape,state
    FROM {SCHEMA}."vx_generations" WHERE id='{GEN}'::uuid) x),
  'publications',COALESCE((SELECT json_agg(row_to_json(x)) FROM (
    SELECT generation_id,id,document_id,source_version_id,expected_count,manifest_hash,epoch::text,state
    FROM {SCHEMA}."vx_publications" WHERE generation_id='{GEN}'::uuid ORDER BY id LIMIT 5) x),'[]'::json),
  'relationKind',(SELECT relkind FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('{SCHEMA}.{TABLE}')),
  'embeddingType',(SELECT pg_catalog.format_type(atttypid,atttypmod) FROM pg_catalog.pg_attribute
    WHERE attrelid=pg_catalog.to_regclass('{SCHEMA}.{TABLE}') AND attname='embedding' AND NOT attisdropped),
  'rowCount',(SELECT count(*) FROM {SCHEMA}.{TABLE}),
  'rows',COALESCE((SELECT json_agg(row_to_json(x)) FROM (
    SELECT chunk_id,publication_id,source_version_id,document_id,generation_id,ordinal,chunk_hash,
      public.vector_dims(embedding) AS dimensions
    FROM {SCHEMA}.{TABLE} ORDER BY publication_id,ordinal LIMIT 641) x),'[]'::json)
)
```

Require one generation ledger with `READY`, exact enrolled org/collection/fingerprint, and saved shape `{dimensions,metric:'cosine',numericType:'float32',indexType}`. Require one publication ledger, `SEALED`, equal app publication/source/document IDs, expected count and manifest. Verify `epoch` is a positive decimal, without assuming it equals the task's later cleanup epoch.

Compare sorted physical tuples `(chunk_id,publication_id,source_version_id,document_id,generation_id,ordinal,chunk_hash)` with tuples constructed from **every application CHILD row** and its owning publication. Require exact equality, unique IDs, contiguous child ordinals starting at zero, and `vector_dims = saved dimensions` for every row. This proves no parent IDs have vectors and no unknown IDs were inserted. Every parent must have null embedding-input hash and no parent; every child must have a nonnull embedding-input hash and a parent in the same publication. Check the app token counts are positive safe integers with boolean estimate flags, ordered positive canonical offsets, and child containment within its parent. These are catalog consistency checks, not a re-tokenization or canonical text reconstruction.

For an independent manifest check, production hashes UTF-8 `JSON.stringify` of child tuples `[chunkId,ordinal,textHash]` sorted by ordinal, with SHA-256. Use the actual exported production `manifestHash` or the exact compact serialization; do not hash PostgreSQL pretty JSON. It must equal both app and vector publication manifests.

## 3. Acceptance boundary

Require the second application snapshot to equal the first. If it changes, no physical PASS is issued from those mixed observations; investigate or repeat the bounded read after the workflow settles. Separate app/vector reads are not an atomic distributed snapshot. Refuse expired retention, dropped/tombstoned A or unexpected rows rather than treating them as evidence of retained A.

Save only the bounded numeric/identifier/hash result in the owned private trial directory. This physical result complements the existing prefix/usage recovery observer, actual dashboard/search and exact-source checks. It does not independently prove vector values, native weights/billing, all canonical geometry, access enforcement or the 100k capacity gate.
