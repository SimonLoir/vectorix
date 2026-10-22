import type { PoolClient } from 'pg';
import { Connection, transaction } from './connection';
import { fail, generationTable, identifier } from './validation';
import type { GenerationSpec } from './types';
export function generationShape(spec: GenerationSpec) {
    return {
        dimensions: spec.dimensions,
        metric: spec.metric,
        numericType: spec.numericType,
        indexType: spec.indexType,
    };
}
async function generationGuard(db: PoolClient, spec: GenerationSpec) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'vectorix-generation:' + spec.id,
    ]);
}
async function insertLedger(
    connection: Connection,
    db: PoolClient,
    spec: GenerationSpec
) {
    return await db.query(
        `INSERT INTO ${connection.table('vx_generations')}(id,organization_id,collection_id,destination_fingerprint,shape,state) VALUES($1,$2,$3,$4,$5,'READY') ON CONFLICT DO NOTHING`,
        [
            spec.id,
            spec.organizationId,
            spec.collectionId,
            spec.destinationFingerprint,
            generationShape(spec),
        ]
    );
}
/** Catalog-derived columns, primary/ordinal keys and actual ANN operator/index shape are verified on every retry. */
async function verifyShape(
    connection: Connection,
    db: PoolClient,
    spec: GenerationSpec
) {
    const table = connection.table(generationTable(spec.id));
    const actual = await db.query(
        'SELECT attname,format_type(atttypid,atttypmod) AS type,attnotnull,attgenerated,attidentity,atthasdef FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum',
        [table]
    );
    const expected = [
        ['chunk_id', 'uuid'],
        ['publication_id', 'uuid'],
        ['source_version_id', 'uuid'],
        ['document_id', 'text'],
        ['generation_id', 'uuid'],
        ['ordinal', 'integer'],
        ['chunk_hash', 'text'],
        ['vector_hash', 'text'],
        ['embedding', `vector(${spec.dimensions})`],
    ];
    if (
        actual.rows.length !== expected.length ||
        actual.rows.some(
            (row, index) =>
                row.attname !== expected[index]![0] ||
                row.type !== expected[index]![1] ||
                !row.attnotnull ||
                Boolean(row.attgenerated) ||
                Boolean(row.attidentity) ||
                Boolean(row.atthasdef)
        )
    )
        fail('SHAPE_MISMATCH');
    const constraints = await db.query(
        "SELECT contype,conkey::smallint[] AS keys,confkey::smallint[] AS target_keys,confrelid=to_regclass($2) AS target_matches,confupdtype,confdeltype,condeferrable,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype<>'n'",
        [table, connection.table('vx_publications')]
    );
    if (
        constraints.rows.length !== 4 ||
        !constraints.rows.some(
            (r) => r.contype === 'p' && JSON.stringify(r.keys) === '[1]'
        ) ||
        !constraints.rows.some(
            (r) => r.contype === 'u' && JSON.stringify(r.keys) === '[2,6]'
        ) ||
        !constraints.rows.some(
            (r) =>
                r.contype === 'f' &&
                JSON.stringify(r.keys) === '[5,2]' &&
                JSON.stringify(r.target_keys) === '[1,2]' &&
                r.target_matches &&
                r.confupdtype === 'a' &&
                r.confdeltype === 'a' &&
                !r.condeferrable
        ) ||
        !constraints.rows.some(
            (r) =>
                r.contype === 'c' &&
                r.definition.replaceAll(/[()\s]/g, '') ===
                    'CHECKordinal>=0ANDordinal<100000'
        )
    )
        fail('SHAPE_MISMATCH');
    const index = (
        await db.query(
            'SELECT am.amname,opc.opcname,i.indisvalid,i.indnkeyatts,i.indkey::smallint[] AS keys FROM pg_class idx JOIN pg_index i ON i.indexrelid=idx.oid JOIN pg_am am ON am.oid=idx.relam JOIN pg_opclass opc ON opc.oid=i.indclass[0] WHERE idx.oid=to_regclass($1) AND i.indrelid=to_regclass($2)',
            [connection.table(generationTable(spec.id) + '_ann'), table]
        )
    ).rows[0];
    if (
        !index ||
        !index.indisvalid ||
        index.amname !== spec.indexType.toLowerCase() ||
        index.opcname !== 'vector_cosine_ops' ||
        index.indnkeyatts !== 1 ||
        index.keys[0] !== 9
    )
        fail('SHAPE_MISMATCH');
}
/** Provisioning DDL and its READY ledger commit atomically; a tombstone survives every later retry. */
export async function provisionGeneration(
    connection: Connection,
    spec: GenerationSpec
) {
    connection.check(spec);
    const pool = connection.provisioner ?? fail('CAPABILITY_UNAVAILABLE');
    return await transaction(
        pool,
        async (db) => {
            await generationGuard(db, spec);
            const inserted = await insertLedger(connection, db, spec);
            await connection.lockGeneration(db, spec, true);
            const table = connection.table(generationTable(spec.id));
            if (inserted.rowCount) {
                await db.query(`CREATE TABLE ${table} (
        chunk_id uuid PRIMARY KEY, publication_id uuid NOT NULL, source_version_id uuid NOT NULL,
        document_id text NOT NULL, generation_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>=0 AND ordinal<100000),
        chunk_hash text NOT NULL, vector_hash text NOT NULL, embedding public.vector(${spec.dimensions}) NOT NULL,
        UNIQUE(publication_id,ordinal), FOREIGN KEY(generation_id,publication_id) REFERENCES ${connection.table('vx_publications')}(generation_id,id))`);
                await db.query(
                    `CREATE INDEX ${identifier(generationTable(spec.id) + '_ann')} ON ${table} USING ${spec.indexType.toLowerCase()} (embedding public.vector_cosine_ops)`
                );
            }
            await verifyShape(connection, db, spec);
            return { tableName: generationTable(spec.id) };
        },
        120_000
    );
}
/** The generation tombstone and DROP take the same destination lock as creation and all bounded reads/writes. */
export async function dropGeneration(
    connection: Connection,
    spec: GenerationSpec
) {
    connection.check(spec);
    const pool = connection.provisioner ?? fail('CAPABILITY_UNAVAILABLE');
    return await transaction(
        pool,
        async (db) => {
            await generationGuard(db, spec);
            await insertLedger(connection, db, spec);
            await connection.lockGeneration(db, spec, true, true);
            await db.query(
                `UPDATE ${connection.table('vx_generations')} SET state='TOMBSTONED' WHERE id=$1`,
                [spec.id]
            );
            await db.query(
                `UPDATE ${connection.table('vx_publications')} SET state='TOMBSTONED' WHERE generation_id=$1`,
                [spec.id]
            );
            await db.query(
                `DROP TABLE IF EXISTS ${connection.table(generationTable(spec.id))}`
            );
        },
        120_000
    );
}
/** Refresh planner statistics after initial bulk load so publication filters are not estimated as one row and sorted unnecessarily. */
export async function analyzeGeneration(
    connection: Connection,
    spec: GenerationSpec
) {
    connection.check(spec);
    const pool = connection.provisioner ?? fail('CAPABILITY_UNAVAILABLE');
    return await transaction(
        pool,
        async (db) => {
            await connection.lockGeneration(db, spec);
            await db.query(
                `ANALYZE ${connection.table(generationTable(spec.id))}`
            );
        },
        120_000
    );
}
