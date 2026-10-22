import type { PoolClient } from 'pg';
import { Connection, transaction } from './connection';
import { fail, generationTable, uuid, vectorLiteral } from './validation';
import type { GenerationSpec, IndexType, SearchHit } from './types';
export interface SearchInput {
    vector: readonly number[];
    allowedPublicationIds: readonly string[];
    /** Optional chunk-granularity filter (e.g. classified language); derive it from authorized app-catalog rows. */
    allowedChunkIds?: readonly string[];
    limit: number;
    mode?: 'exact' | 'ann';
    timeoutMs?: number;
}
/** All application filters enter as publication/chunk whitelists inside the vector SQL, before any ORDER BY/LIMIT. */
export async function searchVectors(
    connection: Connection,
    spec: GenerationSpec,
    input: SearchInput
) {
    connection.check(spec);
    if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 500 ||
        input.allowedPublicationIds.length > 5000 ||
        (input.allowedChunkIds?.length ?? 0) > 100_000 ||
        (input.mode !== undefined && !['exact', 'ann'].includes(input.mode))
    )
        fail('INVALID_INPUT');
    const timeout = input.timeoutMs ?? 3000;
    if (!Number.isInteger(timeout) || timeout < 10 || timeout > 10_000)
        fail('INVALID_INPUT');
    const publications = [...new Set(input.allowedPublicationIds.map(uuid))];
    const chunks = input.allowedChunkIds
        ? [...new Set(input.allowedChunkIds.map(uuid))]
        : null;
    const vector = vectorLiteral(input.vector, spec.dimensions),
        deadline = Date.now() + timeout,
        mode = input.mode ?? 'exact';
    return await transaction(
        connection.runtime,
        async (db) => {
            await connection.lockGeneration(db, spec);
            if (!publications.length || chunks?.length === 0)
                return {
                    hits: [] as SearchHit[],
                    mode,
                    attempts: 0,
                    underfilled: false,
                };
            const sealed = await db.query(
                `SELECT id FROM ${connection.table('vx_publications')} WHERE generation_id=$1 AND id=ANY($2::uuid[]) AND state='SEALED' FOR SHARE`,
                [spec.id, publications]
            );
            const eligible = sealed.rows.map((row) => row.id as string);
            if (!eligible.length)
                return {
                    hits: [] as SearchHit[],
                    mode,
                    attempts: 0,
                    underfilled: false,
                };
            const table = connection.table(generationTable(spec.id));
            const filter =
                'r.publication_id=ANY($2::uuid[]) AND ($3::uuid[] IS NULL OR r.chunk_id=ANY($3::uuid[]))';
            let hits: SearchHit[] = [],
                attempts = 0;
            for (const cap of mode === 'exact' ? [1] : [256, 1024, 4096]) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) fail('STORE_UNAVAILABLE');
                await db.query(
                    "SELECT set_config('statement_timeout',$1,true)",
                    [String(remaining)]
                );
                if (mode === 'ann') await configureAnn(db, spec.indexType, cap);
                const source =
                    mode === 'exact'
                        ? `WITH eligible AS MATERIALIZED (SELECT r.chunk_id,r.publication_id,r.embedding FROM ${table} r WHERE ${filter}) SELECT chunk_id AS "chunkId",publication_id AS "publicationId",embedding <=> $1::public.vector AS distance FROM eligible ORDER BY embedding <=> $1::public.vector LIMIT $4`
                        : `SELECT r.chunk_id AS "chunkId",r.publication_id AS "publicationId",r.embedding <=> $1::public.vector AS distance FROM ${table} r WHERE ${filter} ORDER BY r.embedding <=> $1::public.vector LIMIT $4`;
                const result = await db.query<SearchHit>(source, [
                    vector,
                    eligible,
                    chunks,
                    input.limit,
                ]);
                hits = result.rows;
                attempts++;
                if (mode === 'exact' || hits.length === input.limit) break;
            }
            return {
                hits,
                mode,
                attempts,
                underfilled: mode === 'ann' && hits.length < input.limit,
            };
        },
        timeout
    );
}

/** Bounded native ANN scan settings are transaction-local and cannot bleed through pooled sessions. */
async function configureAnn(db: PoolClient, indexType: IndexType, cap: number) {
    await (indexType === 'HNSW'
        ? db.query(
              "SELECT set_config('hnsw.ef_search',$1,true),set_config('hnsw.iterative_scan','strict_order',true),set_config('hnsw.max_scan_tuples',$2,true)",
              [String(Math.min(cap, 1000)), String(Math.min(cap * 5, 20_000))]
          )
        : db.query(
              "SELECT set_config('diskann.query_search_list_size',$1,true),set_config('diskann.query_rescore',$1,true)",
              [String(cap)]
          ));
}
