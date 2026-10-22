import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Real-schema protocol checks use only the runner's owned disposable database.
// Synthetic acknowledgments/counts prove SQL fences, never external cleanup.
const connectionString = process.env.DATABASE_URL;
if (
    !connectionString ||
    !/^vectorix_(catalog|parent_schema)_test$/.test(
        new URL(connectionString).pathname.slice(1)
    )
)
    throw new Error('Parent lock checks require an owned disposable _test database.');
const require = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const admin = new Client({ connectionString });
const writer = new Client({ connectionString });
const sealer = new Client({ connectionString });
const fixture = await readFile(new URL('./parent-context-fixture.sql', import.meta.url), 'utf8');
const org = 'parent-schema-org';
const generation = '00000000-0000-4000-8000-000000000091';
let proofs = 0;
const prove = (name) => { proofs++; console.log(`Parent PostgreSQL proof ${proofs}: ${name}`); };
const track = (promise) => { void promise.catch(() => {}); return promise; };
async function waitForBlocked(client) {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const result = await admin.query("SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS blocked FROM pg_stat_activity WHERE pid=$1", [pid]);
            if (result.rows[0]?.blocked) return;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail('Expected actual PostgreSQL lock wait was not observed.');
    };
}
async function owner(id, revision, count = 2) {
    await admin.query('SELECT pg_temp.parent_candidate($1,$2,$3)', [id, revision, count]);
    await admin.query("SELECT pg_temp.parent_chunk($1,$2,$3,'PARENT',0,12,NULL,'Alpha. Beta.')", [id + '-parent', id, count]);
}
function children(client, id, ordinals, parentId = id + '-parent', generationId = generation) {
    return client.query(`INSERT INTO "Chunk" (id,"organizationId","generationId","indexedDocumentId",ordinal,kind,text,"textHash","embeddingInputHash","sourceSpans","startOffset","endOffset",language,"tokenCount","parentId")
        SELECT $1||'-child-'||n,$2,$3,$1,n,'CHILD','Alpha.',repeat('a',64),repeat('b',64),
            '[{"source":{"kind":"text","index":0,"start":0,"end":100},"start":0,"end":6}]'::jsonb,
            CASE WHEN $5::text IS NULL THEN NULL ELSE 0 END,CASE WHEN $5::text IS NULL THEN NULL ELSE 6 END,'FR',2,$5
        FROM unnest($4::integer[]) n`, [id, org, generationId, ordinals, parentId]);
}
async function seal(client, id) {
    // The real owner write precedes every aggregate/validation read. The status
    // trigger also independently validates the complete parent/child layout.
    await client.query('UPDATE "IndexedDocument" SET "updatedAt"=clock_timestamp() WHERE id=$1', [id]);
    await client.query('SELECT id,ordinal,"parentId" FROM "Chunk" WHERE "indexedDocumentId"=$1 ORDER BY ordinal', [id]);
    await client.query("UPDATE \"IndexedDocument\" SET status='SEALED',\"manifestHash\"=repeat('c',64) WHERE id=$1 AND status='STAGING'", [id]);
}
async function cleanContent() {
    await admin.query("UPDATE \"IndexedDocument\" SET status='RETIRED' WHERE \"organizationId\"=$1 AND status IN ('STAGING','SEALED','PUBLISHED')", [org]);
    await admin.query("UPDATE \"IndexedDocument\" SET status='CLEANING' WHERE \"organizationId\"=$1 AND status='RETIRED'", [org]);
    await admin.query('DELETE FROM "Chunk" WHERE "organizationId"=$1', [org]);
    await admin.query("UPDATE \"IndexedDocument\" SET status='CLEANED',\"materializedChunks\"=0 WHERE \"organizationId\"=$1 AND status='CLEANING'", [org]);
    await admin.query("UPDATE \"IndexGeneration\" SET status='CLEANED' WHERE \"organizationId\"=$1", [org]);
}
try {
    await Promise.all([admin.connect(), writer.connect(), sealer.connect()]);
    for (const client of [admin, writer, sealer]) await client.query("SET statement_timeout='10s'");
    await admin.query('BEGIN;\n' + fixture + '\nCOMMIT;');

    await owner('parent-lock-writer-first', 2);
    const sealBlocked = await waitForBlocked(sealer);
    await sealer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    assert.equal((await sealer.query("SELECT count(*)::integer AS n FROM \"Chunk\" WHERE \"indexedDocumentId\"='parent-lock-writer-first' AND kind='CHILD'")).rows[0].n, 0);
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await children(writer, 'parent-lock-writer-first', [0, 1]);
    const stale = track(seal(sealer, 'parent-lock-writer-first'));
    await sealBlocked();
    await writer.query('COMMIT');
    await assert.rejects(stale, { code: '40001' });
    await sealer.query('ROLLBACK');
    prove('writer-first tuple touch aborts an already stale SERIALIZABLE sealer');
    await sealer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await seal(sealer, 'parent-lock-writer-first');
    await sealer.query('COMMIT');
    assert.equal((await admin.query("SELECT status FROM \"IndexedDocument\" WHERE id='parent-lock-writer-first'")).rows[0].status, 'SEALED');
    prove('fresh whole-transaction retry seals the complete real schema layout');

    await owner('parent-lock-sealer-first', 3);
    await children(admin, 'parent-lock-sealer-first', [0, 1]);
    const writerBlocked = await waitForBlocked(writer);
    await sealer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await seal(sealer, 'parent-lock-sealer-first');
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const late = track(children(writer, 'parent-lock-sealer-first', [3, 4]));
    await writerBlocked();
    await sealer.query('COMMIT');
    await assert.rejects(late, { code: '23514', constraint: 'Chunk_layout_frozen' });
    await writer.query('ROLLBACK');
    assert.equal((await admin.query("SELECT count(*)::integer AS n FROM \"Chunk\" WHERE \"indexedDocumentId\"='parent-lock-sealer-first'")).rows[0].n, 3);
    prove('sealer-first late multirow INSERT waits, rejects and rolls back every row');

    await owner('parent-lock-noop-update', 4);
    await children(admin, 'parent-lock-noop-update', [0, 1]);
    const updateBlocked = await waitForBlocked(sealer);
    await sealer.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await sealer.query("SELECT id FROM \"Chunk\" WHERE \"indexedDocumentId\"='parent-lock-noop-update'");
    await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await writer.query("UPDATE \"Chunk\" SET text=text WHERE id='parent-lock-noop-update-child-0'");
    const updateRace = track(seal(sealer, 'parent-lock-noop-update'));
    await updateBlocked();
    await writer.query('COMMIT');
    await assert.rejects(updateRace, { code: '40001' });
    await sealer.query('ROLLBACK');
    await assert.rejects(admin.query("UPDATE \"Chunk\" SET \"lexicalSimple\"=to_tsvector('simple','tampered') WHERE id='parent-lock-noop-update-child-0'"), { code: '23514', constraint: 'Chunk_layout_immutable' });
    prove('UPDATE statement touch fences stale reads while canonical/derived mutations are immutable');

    await owner('parent-lock-batch-a', 5, 1000);
    await owner('parent-lock-batch-b', 6, 1000);
    await admin.query('CREATE TABLE "_ParentTouchProof" (owner_id text NOT NULL)');
    await admin.query(`CREATE FUNCTION vectorix_parent_probe_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "_ParentTouchProof" VALUES(NEW.id); RETURN NEW; END $$;
        CREATE TRIGGER vectorix_parent_probe_touch AFTER UPDATE OF "updatedAt" ON "IndexedDocument" FOR EACH ROW EXECUTE FUNCTION vectorix_parent_probe_touch()`);
    await admin.query(`INSERT INTO "Chunk" (id,"organizationId","generationId","indexedDocumentId",ordinal,kind,text,"textHash","embeddingInputHash","sourceSpans","startOffset","endOffset",language,"tokenCount","parentId")
        SELECT 'parent-lock-bulk-'||n,$1,$2,CASE WHEN n<1000 THEN 'parent-lock-batch-a' ELSE 'parent-lock-batch-b' END,n%1000,'CHILD','Alpha.',repeat('a',64),repeat('b',64),
            '[{"source":{"kind":"text","index":0,"start":0,"end":100},"start":0,"end":6}]'::jsonb,0,6,'FR',2,
            CASE WHEN n<1000 THEN 'parent-lock-batch-a-parent' ELSE 'parent-lock-batch-b-parent' END FROM generate_series(0,1999) n`, [org, generation]);
    assert.deepEqual((await admin.query('SELECT owner_id,count(*)::integer AS n FROM "_ParentTouchProof" GROUP BY owner_id ORDER BY owner_id')).rows, [{ owner_id: 'parent-lock-batch-a', n: 1 }, { owner_id: 'parent-lock-batch-b', n: 1 }]);
    await admin.query('DROP TRIGGER vectorix_parent_probe_touch ON "IndexedDocument"; DROP FUNCTION vectorix_parent_probe_touch(); DROP TABLE "_ParentTouchProof"');
    prove('2,000 real Chunk inserts touch exactly two distinct candidate owners');

    await cleanContent();
    // A legacy cleaned owner is deliberately stale: actual Chunk existence and
    // the new descendant organization lock, not cached state, must stop deletion.
    await admin.query("INSERT INTO \"Collection\" (id,\"organizationId\",name,\"updatedAt\",\"deletedAt\") VALUES ('parent-lock-legacy-collection',$1,'Synthetic legacy owner',now(),now())", [org]);
    await admin.query(`INSERT INTO "CollectionConfigRevision" (id,"organizationId","collectionId",revision,"vectorConnectionId",provider,model,dimensions,endpoint,chunking)
        VALUES ('parent-lock-legacy-config',$1,'parent-lock-legacy-collection',1,'parent-schema-vector','OLLAMA','synthetic',2,'http://embedding.example.test','{}')`, [org]);
    await admin.query(`INSERT INTO "IndexGeneration" SELECT (jsonb_populate_record(NULL::"IndexGeneration",to_jsonb(g)||'{"id":"00000000-0000-4000-8000-000000000094","collectionId":"parent-lock-legacy-collection","requestId":"parent-lock-legacy-request","tableName":"g_00000000000040008000000000000094","parentContextVersion":null}')).* FROM "IndexGeneration" g WHERE id=$1`, [generation]);
    await admin.query(`INSERT INTO "IndexedDocument" SELECT (jsonb_populate_record(NULL::"IndexedDocument",to_jsonb(c)||'{"id":"parent-lock-legacy-candidate","generationId":"00000000-0000-4000-8000-000000000094","collectionId":"parent-lock-legacy-collection","chunkCount":1,"materializedChunks":1}')).* FROM "IndexedDocument" c WHERE id='parent-schema-a'`);
    const nativeDeleteBlocked = await waitForBlocked(sealer);
    await writer.query('BEGIN');
    await children(writer, 'parent-lock-legacy-candidate', [0], null, '00000000-0000-4000-8000-000000000094');
    await sealer.query('BEGIN');
    await sealer.query('DELETE FROM member WHERE "organizationId"=$1', [org]);
    const deleting = track(sealer.query('DELETE FROM organization WHERE id=$1', [org]));
    await nativeDeleteBlocked();
    await writer.query('COMMIT');
    await assert.rejects(deleting, { code: '23514', constraint: 'organization_rag_cleanup_required' });
    await sealer.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM member WHERE "organizationId"=$1', [org])).rows[0].n, 1);
    prove('accepted Chunk blocks native members-first deletion and preserves membership');
    await admin.query('DELETE FROM "Chunk" WHERE "organizationId"=$1', [org]);
    const descendantBlocked = await waitForBlocked(writer);
    await sealer.query('BEGIN');
    await sealer.query('DELETE FROM member WHERE "organizationId"=$1', [org]);
    await sealer.query('DELETE FROM organization WHERE id=$1', [org]);
    await writer.query('BEGIN');
    const insertion = track(children(writer, 'parent-lock-legacy-candidate', [0], null, '00000000-0000-4000-8000-000000000094'));
    await descendantBlocked();
    await sealer.query('COMMIT');
    await assert.rejects(insertion, { code: '23503' });
    await writer.query('ROLLBACK');
    assert.equal((await admin.query('SELECT count(*)::integer AS n FROM "Chunk" WHERE "organizationId"=$1', [org])).rows[0].n, 0);
    prove('native deletion wins: late Chunk waits and cannot survive the cleaned metadata cascade');
    console.log(`Parent real-schema concurrency proofs: ${proofs} passed.`);
} finally {
    await Promise.allSettled([writer.query('ROLLBACK'), sealer.query('ROLLBACK'), admin.query('ROLLBACK')]);
    try {
        await admin.query('DROP TRIGGER IF EXISTS vectorix_parent_probe_touch ON "IndexedDocument"; DROP FUNCTION IF EXISTS vectorix_parent_probe_touch(); DROP TABLE IF EXISTS "_ParentTouchProof"');
        await cleanContent();
        await admin.query('DELETE FROM organization WHERE id=$1', [org]);
        await admin.query("DELETE FROM \"user\" WHERE id='parent-schema-user'");
    } finally {
        await Promise.allSettled([writer.end(), sealer.end(), admin.end()]);
    }
}
