import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma, type Prisma } from '@repo/db';
import { getRagTelemetry } from '@routers/rag/telemetry';
import { fixture as f } from './fixtures';
import {
    createTelemetryFixture,
    seedTelemetryMarker,
    telemetryHour,
} from './telemetry-fixtures';

/** Maximum retained tag/window geometry is synthetic aggregate data, not a benchmark of product throughput or quality. */
export async function telemetryLimitTests(t: TestContext) {
    await t.test(
        'all 19440 retained tag-hours aggregate server-side into bounded 720 points and 27 summaries',
        async () => {
            const fixture = await createTelemetryFixture(
                'Worst retained shape'
            );
            try {
                const clock = await seedTelemetryMarker(720);
                const workloadPhases = {
                    EXTRACTION: [
                        'SOURCE_READ',
                        'PARSE_EXTRACT',
                        'ARTIFACT_WRITE',
                        'CATALOG_PUBLISH',
                        'EXECUTION_TOTAL',
                    ],
                    INDEX_STRUCTURE: [
                        'SOURCE_READ',
                        'PLAN',
                        'MATERIALIZE_SEAL',
                        'FINAL_EMBED',
                        'VECTOR_WRITE_SEAL',
                        'CATALOG_PUBLISH',
                        'EXECUTION_TOTAL',
                    ],
                    INDEX_TOKEN: [
                        'SOURCE_READ',
                        'PLAN',
                        'MATERIALIZE_SEAL',
                        'FINAL_EMBED',
                        'VECTOR_WRITE_SEAL',
                        'CATALOG_PUBLISH',
                        'EXECUTION_TOTAL',
                    ],
                    INDEX_SEMANTIC: [
                        'SOURCE_READ',
                        'PLAN',
                        'MATERIALIZE_SEAL',
                        'FINAL_EMBED',
                        'VECTOR_WRITE_SEAL',
                        'CATALOG_PUBLISH',
                        'EXECUTION_TOTAL',
                        'BOUNDARY_EMBED',
                    ],
                    SEARCH_LEXICAL: [
                        'PREFLIGHT',
                        'LEXICAL',
                        'FUSION_HYDRATE',
                        'SERVICE_TOTAL',
                        'INTERNAL_PHASE_UNION',
                    ],
                    SEARCH_VECTOR: [
                        'PREFLIGHT',
                        'QUERY_EMBED',
                        'VECTOR',
                        'FUSION_HYDRATE',
                        'SERVICE_TOTAL',
                        'INTERNAL_PHASE_UNION',
                    ],
                    SEARCH_HYBRID: [
                        'PREFLIGHT',
                        'QUERY_EMBED',
                        'LEXICAL',
                        'VECTOR',
                        'FUSION_HYDRATE',
                        'SERVICE_TOTAL',
                        'INTERNAL_PHASE_UNION',
                    ],
                } as const;
                const lower = [
                    0, 1001, 5001, 10_001, 25_001, 50_001, 100_001, 250_001,
                    500_001, 1_000_001, 2_500_001, 5_000_001, 10_000_001,
                    30_000_001, 90_000_001, 300_000_001,
                ];
                const histogram = {
                    samples: '16',
                    sumMicros: String(
                        lower.reduce((sum, value) => sum + value, 0)
                    ),
                    maxMicros: '300000001',
                    buckets: Array.from({ length: 16 }, () => '1'),
                };
                let rows: Prisma.RagOperationalHourCreateManyInput[] = [];
                let inserted = 0;
                for (let offset = 0; offset < 720; offset++) {
                    const bucketStart = new Date(
                        clock.currentHour.getTime() - offset * telemetryHour
                    );
                    for (const workload of Object.keys(
                        workloadPhases
                    ) as (keyof typeof workloadPhases)[]) {
                        const providers =
                            workload === 'EXTRACTION' ||
                            workload === 'SEARCH_LEXICAL'
                                ? (['NONE'] as const)
                                : ([
                                      'OLLAMA',
                                      'COHERE',
                                      'VOYAGE',
                                      'OPENAI',
                                      'MISTRAL',
                                  ] as const);
                        for (const provider of providers)
                            rows.push({
                                organizationId: f.org,
                                bucketStart,
                                lastRecordedAt: clock.now,
                                workload,
                                provider,
                                recordedStarts: 1n,
                                recordedSuccesses: 1n,
                                phaseStats: Object.fromEntries(
                                    workloadPhases[workload].map((name) => [
                                        name,
                                        histogram,
                                    ])
                                ),
                                failureCounts: {
                                    ACCESS: '1',
                                    PROFILE: '1',
                                    CREDENTIALS: '1',
                                    PROVIDER: '1',
                                    STORAGE: '1',
                                    SOURCE: '1',
                                    VECTOR: '1',
                                    QUOTA: '1',
                                    LEASE: '1',
                                    INPUT: '1',
                                    PROCESSING: '1',
                                    OTHER: '1',
                                },
                            });
                    }
                    if (rows.length >= 128) {
                        inserted += (
                            await prisma.ragOperationalHour.createMany({
                                data: rows,
                            })
                        ).count;
                        rows = [];
                    }
                }
                if (rows.length)
                    inserted += (
                        await prisma.ragOperationalHour.createMany({
                            data: rows,
                        })
                    ).count;
                assert.equal(inserted, 19_440);
                const result = await f.owner.rag.telemetry.summary({
                    window: '30D',
                });
                assert.equal(result.hourly.length, 720);
                assert.equal(result.dimensions.length, 27);
                assert.equal(result.totals?.recordedStarts, '19440');
                assert(
                    result.dimensions.every(
                        (row) =>
                            row.phases.length <= 8 && row.failures.length === 12
                    )
                );
                assert(
                    result.dimensions
                        .flatMap((row) => row.phases)
                        .every(
                            (row) =>
                                row.samples === '11520' &&
                                row.p95.upperMicros === null
                        )
                );
                assert(Buffer.byteLength(JSON.stringify(result)) < 2_097_152);
                assert(
                    result.hourly.every(
                        (row) => row.counters?.recordedStarts === '27'
                    )
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'a blocked telemetry flush cannot change successful document processing and reports a surviving gap without replaying the dropped delta',
        async () => {
            const fixture = await createTelemetryFixture(
                'Metric storage failure'
            );
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: 1,
            });
            try {
                assert(
                    new URL(process.env.DATABASE_URL!).pathname.endsWith(
                        '_test'
                    )
                );
                const recorder = getRagTelemetry(prisma);
                recorder.observe(
                    {
                        organizationId: f.org,
                        workload: 'EXTRACTION',
                        provider: 'NONE',
                    },
                    { recordedStarts: 1n }
                );
                await recorder.flush();
                const lock = await pool.connect();
                let pending: Promise<void> | undefined;
                try {
                    await lock.query('BEGIN');
                    await lock.query(
                        'SELECT "organizationId" FROM "OrganizationRagTelemetry" WHERE "organizationId"=$1 FOR UPDATE',
                        [f.org]
                    );
                    recorder.observe(
                        {
                            organizationId: f.org,
                            workload: 'EXTRACTION',
                            provider: 'NONE',
                        },
                        { recordedStarts: 100n }
                    );
                    pending = recorder.flush();
                    const document = await fixture.upload(
                        'Une forêt française. The English forest stays available.',
                        'telemetry-write-failure.txt'
                    );
                    assert.equal(document.status, 'READY');
                    await pending;
                } finally {
                    await lock.query('ROLLBACK');
                    lock.release();
                    await pending;
                }
                await recorder.flush();
                const result = await f.owner.rag.telemetry.summary({});
                assert(BigInt(result.tracking.knownGapReports) >= 1n);
                assert(BigInt(result.totals!.recordedStarts) < 100n);
                const ingestion =
                    await prisma.documentIngestion.findFirstOrThrow({
                        where: { organizationId: f.org },
                        orderBy: { createdAt: 'desc' },
                    });
                assert.equal(ingestion.status, 'READY');
            } finally {
                await pool.end();
                await fixture.close();
            }
        }
    );
}
