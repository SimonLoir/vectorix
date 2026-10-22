import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import {
    VectorStore,
    VectorStoreError,
    generationTable,
    manifestHash,
    type DestinationConfig,
    type GenerationSpec,
    type PublicationSpec,
    type VectorRow,
} from '../src/index';
import { sha256 } from '../src/validation';
const config = JSON.parse(
    process.env.VECTOR_ADAPTER_TEST_CONFIG!
) as DestinationConfig;
assert.ok(
    new URL(config.runtimeUrl).pathname.endsWith('_test'),
    'Only isolated _test databases are permitted.'
);
const store = new VectorStore(config);
const runtime = new Pool({ connectionString: config.runtimeUrl }),
    provisioner = new Pool({ connectionString: config.provisioningUrl }),
    admin = new Pool({
        connectionString: process.env.VECTOR_ADAPTER_TEST_ADMIN_URL,
    });
const code = (expected: string) => (error: unknown) =>
    error instanceof VectorStoreError &&
    error.code === expected &&
    error.message === expected;
function publication(rows: readonly VectorRow[]): PublicationSpec {
    return {
        id: randomUUID(),
        documentId: randomUUID(),
        sourceVersionId: randomUUID(),
        expectedCount: rows.length,
        manifestHash: manifestHash(rows),
    };
}
function vectors(
    count: number,
    vector = (n: number) => [
        Math.cos((2 * Math.PI * n) / count),
        Math.sin((2 * Math.PI * n) / count),
        0.1,
    ]
) {
    return Array.from({ length: count }, (_, ordinal) => ({
        chunkId: randomUUID(),
        ordinal,
        chunkHash: sha256('chunk-' + ordinal),
        vector: vector(ordinal),
    }));
}
async function insert(spec: GenerationSpec, rows: VectorRow[]) {
    const p = publication(rows);
    await store.open(spec, p, 1n);
    for (let i = 0; i < rows.length; i += 128)
        await store.write(spec, p, 1n, rows.slice(i, i + 128));
    await store.seal(spec, p, 1n);
    return p;
}
async function blocked(sqlPattern: string) {
    for (let i = 0; i < 100; i++) {
        const result = await admin.query(
            "SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1",
            [sqlPattern]
        );
        if (result.rows[0].n > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Expected real PostgreSQL row-lock contention.');
}
void test('vector adapter with isolated PostgreSQL18/pgvector/pgvectorscale and actual provisioner/runtime roles', async (t) => {
    t.after(async () => {
        await Promise.all([
            store.close(),
            runtime.end(),
            provisioner.end(),
            admin.end(),
        ]);
    });
    const destinationFingerprint = await store.initialize();
    assert.match(destinationFingerprint, /^[a-f0-9]{64}$/);
    const spec = (
        indexType: 'HNSW' | 'DISKANN' = 'HNSW',
        dimensions = 3
    ): GenerationSpec => ({
        id: randomUUID(),
        organizationId: 'org-adapter-test',
        collectionId: 'collection-adapter-test',
        dimensions,
        metric: 'cosine',
        numericType: 'float32',
        indexType,
        destinationFingerprint,
    });
    await t.test(
        'password-authenticated role boundaries and destination identity survive reinitialization',
        async () => {
            const result = await runtime.query(
                'SELECT current_user,(SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user) AS privileged'
            );
            assert.equal(result.rows[0].current_user, 'vectorix_runtime');
            assert.equal(result.rows[0].privileged, false);
            await assert.rejects(
                runtime.query(
                    'CREATE TABLE vector_collections.runtime_forbidden(id int)'
                ),
                (e: Error & { code?: string }) => e.code === '42501'
            );
            await assert.rejects(
                provisioner.query(
                    'CREATE TABLE public.indexer_forbidden(id int)'
                ),
                (e: Error & { code?: string }) => e.code === '42501'
            );
            assert.equal(await store.initialize(), destinationFingerprint);
            await assert.rejects(
                store.provision({
                    ...spec(),
                    destinationFingerprint: 'a'.repeat(64),
                }),
                code('DESTINATION_DRIFT')
            );
            assert.throws(
                () =>
                    new VectorStore({
                        ...config,
                        provisioningUrl: config.provisioningUrl!.replace(
                            '_test',
                            '_other_test'
                        ),
                    }),
                code('DESTINATION_DRIFT')
            );
        }
    );
    await t.test(
        'persistent database identity detects replacement and credential rotation preserves binding',
        async () => {
            const identity = (
                await admin.query(
                    'SELECT identity FROM vector_collections.vx_identity WHERE singleton'
                )
            ).rows[0].identity as string;
            await admin.query(
                'UPDATE vector_collections.vx_identity SET identity=$1 WHERE singleton',
                [randomUUID()]
            );
            const runtimeOnly = new VectorStore({
                runtimeUrl: config.runtimeUrl,
                schema: config.schema,
            });
            try {
                assert.notEqual(
                    await runtimeOnly.initialize(),
                    destinationFingerprint
                );
                await assert.rejects(
                    store.initialize(),
                    code('DESTINATION_DRIFT')
                );
            } finally {
                await runtimeOnly.close();
                await admin.query(
                    'UPDATE vector_collections.vx_identity SET identity=$1 WHERE singleton',
                    [identity]
                );
            }
            await admin.query(
                "ALTER ROLE vectorix_runtime WITH PASSWORD 'adapter-test-runtime-rotated'"
            );
            const rotatedUrl = new URL(config.runtimeUrl);
            rotatedUrl.password = 'adapter-test-runtime-rotated';
            const rotated = new VectorStore({
                runtimeUrl: rotatedUrl.href,
                schema: config.schema,
            });
            try {
                assert.equal(
                    await rotated.initialize(),
                    destinationFingerprint
                );
            } finally {
                await rotated.close();
                await admin.query(
                    "ALTER ROLE vectorix_runtime WITH PASSWORD 'adapter-test-runtime'"
                );
            }
            assert.equal(await store.initialize(), destinationFingerprint);
        }
    );
    await t.test(
        'driver target overrides are rejected and TLS environment drift fails closed',
        async () => {
            for (const query of [
                'host=other-host',
                'port=6543',
                'ssl=true',
                'options=-c%20search_path%3Dpublic',
                'sslmode=disable&sslmode=verify-full',
            ]) {
                assert.throws(
                    () =>
                        new VectorStore({
                            ...config,
                            runtimeUrl: `${config.runtimeUrl}?${query}`,
                        }),
                    code('INVALID_INPUT')
                );
            }
            const prior = process.env.PGSSLMODE;
            process.env.PGSSLMODE = prior === 'require' ? 'disable' : 'require';
            try {
                await assert.rejects(
                    store.initialize(),
                    code('DESTINATION_DRIFT')
                );
            } finally {
                if (prior === undefined) delete process.env.PGSSLMODE;
                else process.env.PGSSLMODE = prior;
            }
            assert.equal(await store.initialize(), destinationFingerprint);
        }
    );
    for (const method of ['HNSW', 'DISKANN'] as const) {
        await t.test(
            `${method} provision/index shape, filtered exact/ANN topK and immutable sealed manifests`,
            async () => {
                const g = spec(method);
                await store.provision(g);
                await store.provision(g);
                const rows = vectors(300, (n) => [
                    -0.1 - Math.abs(Math.sin(n)),
                    0.5 + Math.abs(Math.cos(n)),
                    0.1,
                ]);
                const current = await insert(g, rows);
                const obsolete = await insert(
                    g,
                    vectors(400, () => [1, 0, 0])
                );
                const unsealedRows = vectors(1, () => [1, 0, 0]),
                    unsealed = publication(unsealedRows);
                await store.open(g, unsealed, 1n);
                await store.write(g, unsealed, 1n, unsealedRows);
                await store.analyze(g);
                for (const mode of ['exact', 'ann'] as const) {
                    const result = await store.search(g, {
                        vector: [1, 0, 0],
                        allowedPublicationIds: [current.id, unsealed.id],
                        limit: 10,
                        mode,
                    });
                    assert.equal(result.hits.length, 10);
                    assert.ok(
                        result.hits.every(
                            (hit) => hit.publicationId === current.id
                        )
                    );
                    assert.ok(
                        result.hits.every((hit) =>
                            Number.isFinite(hit.distance)
                        )
                    );
                    const chunkFilter: string[] = rows
                        .slice(30, 35)
                        .map((r) => r.chunkId);
                    const filtered = await store.search(g, {
                        vector: [1, 0, 0],
                        allowedPublicationIds: [current.id, obsolete.id],
                        allowedChunkIds: chunkFilter,
                        limit: 5,
                        mode,
                    });
                    assert.equal(filtered.hits.length, 5);
                    assert.ok(
                        filtered.hits.every((hit) =>
                            chunkFilter.includes(hit.chunkId)
                        )
                    );
                }
                const client = await runtime.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('SET LOCAL enable_seqscan=off');
                    const plan = await client.query(
                        `EXPLAIN SELECT r.chunk_id FROM vector_collections.${generationTable(g.id)} r WHERE r.publication_id=ANY($1::uuid[]) ORDER BY r.embedding <=> '[1,0,0]'::public.vector LIMIT 10`,
                        [[current.id, obsolete.id]]
                    );
                    assert.ok(
                        plan.rows.some((row) =>
                            row['QUERY PLAN'].includes(
                                generationTable(g.id) + '_ann'
                            )
                        ),
                        JSON.stringify(plan.rows)
                    );
                    await client.query('ROLLBACK');
                } finally {
                    await client.query('ROLLBACK');
                    client.release();
                }
                const runtimeOnly = new VectorStore({
                    runtimeUrl: config.runtimeUrl,
                    schema: config.schema,
                });
                try {
                    assert.equal(
                        await runtimeOnly.initialize(),
                        destinationFingerprint
                    );
                    assert.equal(
                        (
                            await runtimeOnly.search(g, {
                                vector: [1, 0, 0],
                                allowedPublicationIds: [current.id],
                                limit: 1,
                            })
                        ).hits.length,
                        1
                    );
                    await assert.rejects(
                        runtimeOnly.provision(g),
                        code('CAPABILITY_UNAVAILABLE')
                    );
                } finally {
                    await runtimeOnly.close();
                }
                assert.deepEqual(
                    (
                        await store.search(g, {
                            vector: [1, 0, 0],
                            allowedPublicationIds: [],
                            limit: 5,
                        })
                    ).hits,
                    []
                );
                const adopted = await store.open(g, current, 99n);
                assert.equal(adopted.state, 'SEALED');
                await assert.rejects(
                    store.write(g, current, 1n, rows.slice(0, 1)),
                    code('PUBLICATION_IMMUTABLE')
                );
                await store.seal(g, current, 99n);
                await assert.rejects(
                    store.provision({ ...g, dimensions: 4 }),
                    code('SHAPE_MISMATCH')
                );
                await assert.rejects(
                    store.search(
                        { ...g, organizationId: 'other-org' },
                        {
                            vector: [1, 0, 0],
                            allowedPublicationIds: [current.id],
                            limit: 1,
                        }
                    ),
                    code('SHAPE_MISMATCH')
                );
                await assert.rejects(
                    runtime.query(
                        `DROP TABLE vector_collections.${generationTable(g.id)}`
                    ),
                    (e: Error & { code?: string }) => e.code === '42501'
                );
                await store.drop(g);
                await store.drop(g);
                await assert.rejects(store.provision(g), code('TOMBSTONED'));
            }
        );
    }
    await t.test(
        'actual HNSW and DiskANN dimension limits reject unsupported profiles before table creation',
        async () => {
            await assert.rejects(
                store.provision(spec('HNSW', 2001)),
                code('INVALID_INPUT')
            );
            await assert.rejects(
                store.provision(spec('DISKANN', 16_001)),
                code('INVALID_INPUT')
            );
            const large = spec('DISKANN', 16_000);
            await store.provision(large);
            const rows = vectors(1, () =>
                Array.from({ length: 16_000 }, (_, i) => (i === 0 ? 1 : 0))
            );
            const p = await insert(large, rows);
            assert.equal(
                (
                    await store.search(large, {
                        vector: rows[0]!.vector,
                        allowedPublicationIds: [p.id],
                        limit: 1,
                        mode: 'ann',
                    })
                ).hits[0]?.chunkId,
                rows[0]?.chunkId
            );
            await store.drop(large);
        }
    );
    await t.test(
        'reclaimed epoch discards partial vectors, fences stale batches, and count/hash must seal exactly',
        async () => {
            const g = spec();
            await store.provision(g);
            const rows = vectors(3),
                p = publication(rows);
            await store.open(g, p, 1n);
            await store.write(g, p, 1n, rows.slice(0, 1));
            await assert.rejects(
                store.seal(g, p, 1n),
                code('MANIFEST_MISMATCH')
            );
            await store.open(g, p, 2n);
            assert.equal(
                (
                    await runtime.query(
                        `SELECT count(*)::integer AS n FROM vector_collections.${generationTable(g.id)}`
                    )
                ).rows[0].n,
                0
            );
            await assert.rejects(
                store.write(g, p, 1n, rows),
                code('STALE_EPOCH')
            );
            await assert.rejects(store.open(g, p, 1n), code('STALE_EPOCH'));
            await store.write(g, p, 2n, rows);
            await store.write(g, p, 2n, rows);
            await assert.rejects(
                store.write(g, p, 2n, [{ ...rows[0]!, vector: [0, 1, 0] }]),
                code('MANIFEST_MISMATCH')
            );
            await store.seal(g, p, 2n);
            await store.tombstone(g, p);
            await store.tombstone(g, p);
            await assert.rejects(store.open(g, p, 3n), code('TOMBSTONED'));
            await assert.rejects(
                store.write(g, p, 2n, rows),
                code('TOMBSTONED')
            );
            const neverOpened = publication(vectors(1));
            await store.tombstone(g, neverOpened);
            await assert.rejects(
                store.open(g, neverOpened, 1n),
                code('TOMBSTONED')
            );
            await store.drop(g);
        }
    );
    await t.test(
        'publication cleanup blocks on real writer lock then denies the queued stale write',
        async () => {
            const g = spec();
            await store.provision(g);
            const rows = vectors(1),
                p = publication(rows);
            await store.open(g, p, 1n);
            const held = await runtime.connect();
            await held.query('BEGIN');
            await held.query(
                'SELECT * FROM vector_collections.vx_publications WHERE generation_id=$1 AND id=$2 FOR UPDATE',
                [g.id, p.id]
            );
            try {
                const cleanup = store.tombstone(g, p);
                await blocked('%vx_publications%FOR UPDATE%');
                const late = store.write(g, p, 1n, rows);
                const rejected = assert.rejects(late, code('TOMBSTONED'));
                await held.query('COMMIT');
                await cleanup;
                await rejected;
            } finally {
                await held.query('ROLLBACK');
                held.release();
            }
            await store.drop(g);
        }
    );
    await t.test(
        'generation drop serializes with real in-flight reads and permanent tombstones prevent late recreation',
        async () => {
            const g = spec();
            await store.provision(g);
            const held = await runtime.connect();
            await held.query('BEGIN');
            await held.query(
                'SELECT * FROM vector_collections.vx_generations WHERE id=$1 FOR SHARE',
                [g.id]
            );
            try {
                const cleanup = store.drop(g);
                await blocked('%vx_generations%FOR UPDATE%');
                await held.query('COMMIT');
                await cleanup;
            } finally {
                await held.query('ROLLBACK');
                held.release();
            }
            await assert.rejects(store.provision(g), code('TOMBSTONED'));
            const p = publication(vectors(1));
            await assert.rejects(store.open(g, p, 2n), code('TOMBSTONED'));
            const beforeCreate = spec();
            await store.drop(beforeCreate);
            await assert.rejects(
                store.provision(beforeCreate),
                code('TOMBSTONED')
            );
        }
    );
    await t.test(
        'bad vectors/identifiers/manifests and real schema drift fail safely',
        async () => {
            const g = spec();
            await store.provision(g);
            const rows = vectors(1),
                p = publication(rows);
            await store.open(g, p, 1n);
            for (const vector of [
                [1, 2],
                [Number.NaN, 0, 0],
                [Infinity, 0, 0],
                [0, 0, 0],
                [1e300, 0, 0],
                [1e-300, 0, 0],
            ])
                await assert.rejects(
                    store.write(g, p, 1n, [{ ...rows[0]!, vector }]),
                    code('INVALID_INPUT')
                );
            await assert.rejects(
                store.write(g, p, 0n, rows),
                code('INVALID_INPUT')
            );
            await assert.rejects(
                store.provision({ ...g, id: 'x;DROP TABLE public.users' }),
                code('INVALID_INPUT')
            );
            await provisioner.query(
                `ALTER TABLE vector_collections.${generationTable(g.id)} ADD COLUMN unexpected text`
            );
            await assert.rejects(store.provision(g), code('SHAPE_MISMATCH'));
            await store.drop(g);
        }
    );
});
