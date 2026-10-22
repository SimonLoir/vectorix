import type { PoolClient } from 'pg';
import { Connection, transaction } from './connection';
import {
    epoch,
    fail,
    generationTable,
    fingerprint,
    manifestHash,
    uuid,
    validatePublication,
    vectorLiteral,
    sha256,
} from './validation';
import type { GenerationSpec, PublicationSpec, VectorRow } from './types';
interface PublicationLedgerRow {
    document_id: string;
    source_version_id: string;
    expected_count: number;
    manifest_hash: string;
    state: 'OPEN' | 'SEALED' | 'TOMBSTONED';
    epoch: string;
}
async function publicationRow(
    connection: Connection,
    db: PoolClient,
    spec: GenerationSpec,
    publication: PublicationSpec
) {
    const row = (
        await db.query<PublicationLedgerRow>(
            `SELECT * FROM ${connection.table('vx_publications')} WHERE generation_id=$1 AND id=$2 FOR UPDATE`,
            [spec.id, publication.id]
        )
    ).rows[0];
    if (
        !row ||
        row.document_id !== publication.documentId ||
        row.source_version_id !== publication.sourceVersionId ||
        row.expected_count !== publication.expectedCount ||
        row.manifest_hash !== publication.manifestHash
    )
        fail('MANIFEST_MISMATCH');
    if (row.state === 'TOMBSTONED') fail('TOMBSTONED');
    return row;
}
/** A newer application task epoch fences old writers and discards their unsealed partial stage. SEALED stages can be adopted after a worker crash. */
export async function openPublication(
    connection: Connection,
    spec: GenerationSpec,
    publication: PublicationSpec,
    taskEpoch: bigint
) {
    connection.check(spec);
    validatePublication(publication);
    const value = epoch(taskEpoch);
    return await transaction(connection.runtime, async (db) => {
        await connection.lockGeneration(db, spec);
        await db.query(
            `INSERT INTO ${connection.table('vx_publications')}(generation_id,id,document_id,source_version_id,expected_count,manifest_hash,epoch,state) VALUES($1,$2,$3,$4,$5,$6,$7,'OPEN') ON CONFLICT DO NOTHING`,
            [
                spec.id,
                publication.id,
                publication.documentId,
                publication.sourceVersionId,
                publication.expectedCount,
                publication.manifestHash,
                value,
            ]
        );
        const row = await publicationRow(connection, db, spec, publication);
        if (row.state === 'SEALED')
            return { state: 'SEALED' as const, epoch: BigInt(row.epoch) };
        if (BigInt(row.epoch) > taskEpoch) fail('STALE_EPOCH');
        if (BigInt(row.epoch) < taskEpoch) {
            await db.query(
                `DELETE FROM ${connection.table(generationTable(spec.id))} WHERE publication_id=$1`,
                [publication.id]
            );
            await db.query(
                `UPDATE ${connection.table('vx_publications')} SET epoch=$3 WHERE generation_id=$1 AND id=$2`,
                [spec.id, publication.id, value]
            );
        }
        return { state: 'OPEN' as const, epoch: taskEpoch };
    });
}
/** Every batch locks generation SHARE then publication UPDATE; input identifiers, values and vectors remain bound parameters. */
export async function writeBatch(
    connection: Connection,
    spec: GenerationSpec,
    publication: PublicationSpec,
    taskEpoch: bigint,
    rows: readonly VectorRow[]
) {
    connection.check(spec);
    validatePublication(publication);
    epoch(taskEpoch);
    if (!rows.length || rows.length > 128) fail('INVALID_INPUT');
    const prepared = rows.map((row) => {
        uuid(row.chunkId);
        fingerprint(row.chunkHash);
        if (
            !Number.isInteger(row.ordinal) ||
            row.ordinal < 0 ||
            row.ordinal >= publication.expectedCount
        )
            fail('INVALID_INPUT');
        const vector = vectorLiteral(row.vector, spec.dimensions);
        return { ...row, vector, vectorHash: sha256(vector) };
    });
    if (
        new Set(prepared.map((r) => r.chunkId)).size !== rows.length ||
        new Set(prepared.map((r) => r.ordinal)).size !== rows.length
    )
        fail('INVALID_INPUT');
    return await transaction(connection.runtime, async (db) => {
        await connection.lockGeneration(db, spec);
        const held = await publicationRow(connection, db, spec, publication);
        if (held.state !== 'OPEN') fail('PUBLICATION_IMMUTABLE');
        if (BigInt(held.epoch) !== taskEpoch) fail('STALE_EPOCH');
        const table = connection.table(generationTable(spec.id));
        const values: unknown[] = [];
        const placeholders = prepared.map((row) => {
            const start = values.length;
            values.push(
                row.chunkId,
                publication.id,
                publication.sourceVersionId,
                publication.documentId,
                spec.id,
                row.ordinal,
                row.chunkHash,
                row.vectorHash,
                row.vector
            );
            return (
                '(' +
                Array.from(
                    { length: 9 },
                    (_, index) =>
                        '$' +
                        (start + index + 1) +
                        (index === 8 ? '::public.vector' : '')
                ).join(',') +
                ')'
            );
        });
        const result = await db.query(
            `INSERT INTO ${table} AS existing (chunk_id,publication_id,source_version_id,document_id,generation_id,ordinal,chunk_hash,vector_hash,embedding) VALUES ${placeholders.join(',')} ON CONFLICT(chunk_id) DO UPDATE SET chunk_id=excluded.chunk_id WHERE existing.publication_id=excluded.publication_id AND existing.source_version_id=excluded.source_version_id AND existing.document_id=excluded.document_id AND existing.generation_id=excluded.generation_id AND existing.ordinal=excluded.ordinal AND existing.chunk_hash=excluded.chunk_hash AND existing.vector_hash=excluded.vector_hash`,
            values
        );
        if (result.rowCount !== prepared.length) fail('MANIFEST_MISMATCH');
    });
}
/** Seal verifies a complete immutable chunk manifest under the publication lock before app-catalog publication can occur. */
export async function sealPublication(
    connection: Connection,
    spec: GenerationSpec,
    publication: PublicationSpec,
    taskEpoch: bigint
) {
    connection.check(spec);
    validatePublication(publication);
    epoch(taskEpoch);
    return await transaction(
        connection.runtime,
        async (db) => {
            await connection.lockGeneration(db, spec);
            const held = await publicationRow(
                connection,
                db,
                spec,
                publication
            );
            if (held.state === 'OPEN' && BigInt(held.epoch) !== taskEpoch)
                fail('STALE_EPOCH');
            const result = await db.query(
                `SELECT chunk_id AS "chunkId",ordinal,chunk_hash AS "chunkHash" FROM ${connection.table(generationTable(spec.id))} WHERE publication_id=$1 ORDER BY ordinal LIMIT 100001`,
                [publication.id]
            );
            if (
                result.rows.length !== publication.expectedCount ||
                result.rows.some((row, index) => row.ordinal !== index) ||
                manifestHash(result.rows) !== publication.manifestHash
            )
                fail('MANIFEST_MISMATCH');
            await db.query(
                `UPDATE ${connection.table('vx_publications')} SET state='SEALED' WHERE generation_id=$1 AND id=$2`,
                [spec.id, publication.id]
            );
            return {
                count: result.rows.length,
                manifestHash: publication.manifestHash,
                epoch: BigInt(held.epoch),
            };
        },
        30_000
    );
}
/** Cleanup writes the permanent tombstone before deleting rows; a late claim or write cannot resurrect this publication. */
export async function tombstonePublication(
    connection: Connection,
    spec: GenerationSpec,
    publication: PublicationSpec
) {
    connection.check(spec);
    validatePublication(publication);
    return await transaction(connection.runtime, async (db) => {
        await connection.lockGeneration(db, spec);
        await db.query(
            `INSERT INTO ${connection.table('vx_publications')}(generation_id,id,document_id,source_version_id,expected_count,manifest_hash,epoch,state) VALUES($1,$2,$3,$4,$5,$6,1,'TOMBSTONED') ON CONFLICT DO NOTHING`,
            [
                spec.id,
                publication.id,
                publication.documentId,
                publication.sourceVersionId,
                publication.expectedCount,
                publication.manifestHash,
            ]
        );
        const held = (
            await db.query(
                `SELECT * FROM ${connection.table('vx_publications')} WHERE generation_id=$1 AND id=$2 FOR UPDATE`,
                [spec.id, publication.id]
            )
        ).rows[0];
        if (
            held.document_id !== publication.documentId ||
            held.source_version_id !== publication.sourceVersionId ||
            held.manifest_hash !== publication.manifestHash ||
            held.expected_count !== publication.expectedCount
        )
            fail('MANIFEST_MISMATCH');
        await db.query(
            `UPDATE ${connection.table('vx_publications')} SET state='TOMBSTONED' WHERE generation_id=$1 AND id=$2`,
            [spec.id, publication.id]
        );
        await db.query(
            `DELETE FROM ${connection.table(generationTable(spec.id))} WHERE publication_id=$1`,
            [publication.id]
        );
    });
}
