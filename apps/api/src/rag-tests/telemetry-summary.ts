import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { RagTelemetryRecorder } from '@routers/rag/telemetry';
import { fixture as f } from './fixtures';
import {
    createTelemetryFixture,
    dimension,
    seedTelemetryHour,
    seedTelemetryMarker,
    telemetryHour,
    telemetryOnePhase,
} from './telemetry-fixtures';

/** Synthetic persisted aggregates validate read semantics independently from real domain instrumentation. */
export async function telemetrySummaryTests(t: TestContext) {
    await t.test(
        'recorded activity distinguishes untracked, tracked-empty, actual zero bytes and unknown native usage',
        async () => {
            const fixture = await createTelemetryFixture('Unknown history');
            try {
                const absent = await f.owner.rag.telemetry.summary({});
                assert.equal(absent.state, 'NOT_TRACKED');
                assert.equal(absent.coverage, 'BEST_EFFORT');
                assert.equal(absent.totals, null);
                assert.equal(absent.tracking.trackingSince, null);
                assert.equal(absent.hourly.length, 24);
                assert(
                    absent.hourly.every(
                        (row) =>
                            row.state === 'NOT_TRACKED' && row.counters === null
                    )
                );
                await seedTelemetryMarker(1);
                const empty = await f.owner.rag.telemetry.summary({});
                assert.equal(empty.state, 'NO_RECORDED_ACTIVITY');
                assert.equal(empty.totals?.recordedStarts, '0');
                assert.equal(empty.totals?.sourceReadBytes, null);
                assert.equal(empty.totals?.validatedVectors, null);
                const recorder = new RagTelemetryRecorder(prisma);
                recorder.observe(
                    {
                        organizationId: f.org,
                        workload: 'EXTRACTION',
                        provider: 'NONE',
                    },
                    { recordedStarts: 1n, sourceReadBytes: 0n }
                );
                await recorder.flush();
                const recorded = await f.owner.rag.telemetry.summary({});
                assert.equal(recorded.state, 'RECORDED');
                assert.equal(recorded.totals?.sourceReadBytes, '0');
                assert.equal(recorded.totals?.artifactWrittenBytes, null);
                assert.equal(recorded.totals?.knownProviderInputTokens, null);
                assert.equal(
                    recorded.totals?.validatedEstimatedInputTokens,
                    null
                );
                assert.equal(recorded.totals?.recordedSuccesses, '0');
                assert.equal(recorded.dimensions.length, 1);
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'UTC partial-hour windows aggregate exact decimal counters and histogram intervals while preserving known/unknown subtotals',
        async () => {
            const fixture = await createTelemetryFixture('Exact aggregates');
            try {
                const clock = await seedTelemetryMarker(720);
                await seedTelemetryHour(clock.currentHour, {
                    workload: 'SEARCH_HYBRID',
                    provider: 'OLLAMA',
                    recordedSuccesses: 1n,
                    nativeValidatedBatches: 1n,
                    validatedVectors: 1n,
                    validatedEstimatedInputTokens: 3n,
                    knownProviderInputTokens: 0n,
                    unknownBilledTokenBatches: 1n,
                    phaseStats: { INTERNAL_PHASE_UNION: telemetryOnePhase },
                });
                await seedTelemetryHour(
                    new Date(clock.currentHour.getTime() - telemetryHour),
                    {
                        workload: 'SEARCH_HYBRID',
                        provider: 'OLLAMA',
                        recordedStarts: 9_007_199_254_740_993n,
                        nativeValidatedBatches: 1n,
                        validatedVectors: 2n,
                        validatedEstimatedInputTokens: 6n,
                        unknownProviderTokenBatches: 1n,
                        knownBilledInputTokens: 0.5,
                        phaseStats: { INTERNAL_PHASE_UNION: telemetryOnePhase },
                        failureCounts: { PROVIDER: '1' },
                    }
                );
                await seedTelemetryHour(
                    new Date(clock.currentHour.getTime() - 24 * telemetryHour),
                    {
                        workload: 'EXTRACTION',
                        provider: 'NONE',
                        sourceReadBytes: 7n,
                    }
                );
                await seedTelemetryHour(
                    new Date(clock.currentHour.getTime() - 720 * telemetryHour),
                    {
                        workload: 'EXTRACTION',
                        provider: 'NONE',
                        sourceReadBytes: 999n,
                    }
                );
                const day = await f.owner.rag.telemetry.summary({
                    window: '24H',
                });
                assert.equal(day.hourCount, 24);
                assert.equal(
                    day.windowStart.getTime(),
                    clock.currentHour.getTime() - 23 * telemetryHour
                );
                assert.equal(
                    day.hourly.at(-1)?.bucketStart.getTime(),
                    clock.currentHour.getTime()
                );
                assert(day.windowEnd >= day.hourly.at(-1)!.bucketStart);
                assert.equal(day.totals?.recordedStarts, '9007199254740993');
                assert.equal(day.totals?.sourceReadBytes, null);
                assert.equal(day.totals?.validatedVectors, '3');
                assert.equal(day.totals?.knownProviderInputTokens, '0');
                assert.equal(day.totals?.unknownProviderTokenBatches, '1');
                assert.equal(day.totals?.knownBilledInputTokens, 0.5);
                assert.equal(day.totals?.unknownBilledTokenBatches, '1');
                const phase = dimension(day, 'SEARCH_HYBRID').phases[0]!;
                assert.equal(phase.samples, '2');
                assert.equal(phase.totalMicros, '2002');
                assert.equal(phase.maxMicros, '1001');
                assert.deepEqual(phase.p95, {
                    lowerMicros: '1001',
                    upperMicros: '5000',
                });
                assert.deepEqual(dimension(day, 'SEARCH_HYBRID').failures, [
                    { code: 'PROVIDER', count: '1' },
                ]);
                const month = await f.owner.rag.telemetry.summary({
                    window: '30D',
                });
                // Retention is the current partial UTC hour and its previous
                // 719 buckets, matching pruning rather than an extra trailing
                // fractional hour for which no retained bucket is promised.
                assert.equal(
                    month.retainedFrom.getTime(),
                    month.windowStart.getTime()
                );
                assert.equal(month.hourCount, 720);
                assert.equal(month.totals?.sourceReadBytes, '7');
                assert.equal(month.hourly.length, 720);
                assert(
                    month.hourly.every(
                        (row) => row.bucketStart >= month.windowStart
                    )
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'overflowing historical subtotals fail explicitly without rounded or silently truncated telemetry',
        async () => {
            const fixture = await createTelemetryFixture('Overflow refusal');
            try {
                const clock = await seedTelemetryMarker(2);
                for (const hoursAgo of [0, 1])
                    await seedTelemetryHour(
                        new Date(
                            clock.currentHour.getTime() -
                                hoursAgo * telemetryHour
                        ),
                        {
                            workload: 'EXTRACTION',
                            provider: 'NONE',
                            recordedStarts: 9_223_372_036_854_775_807n,
                        }
                    );
                await assert.rejects(
                    f.owner.rag.telemetry.summary({}),
                    (error: unknown) => {
                        assert(
                            error &&
                                typeof error === 'object' &&
                                'code' in error
                        );
                        assert.equal(error.code, 'SERVICE_UNAVAILABLE');
                        assert(!JSON.stringify(error).includes('SELECT'));
                        return true;
                    }
                );
            } finally {
                await fixture.close();
            }
        }
    );
}
