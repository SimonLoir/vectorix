import { ORPCError } from '@orpc/server';
import { type Prisma, type PrismaClient } from '@repo/db';
import {
    telemetryInput,
    telemetrySummary,
} from '@repo/api-contracts/v1/rag/telemetry';
import { workerObservations } from '@repo/api-contracts/v1/superadmin/telemetry';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor } from '../access';
import { readAggregates } from './queries';
import { mapCounters, mapPhase, sumCounters } from './mapping';

type Input = { window: '24H' | '7D' | '30D' };
const hour = 3_600_000;

/** A read failure exposes no SQL, provider response or private configuration. */
async function sanitized<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('SERVICE_UNAVAILABLE', {
            message: 'Recorded activity is temporarily unavailable.',
        });
    }
}

async function snapshot(
    db: Prisma.TransactionClient,
    organizationId: string,
    input: Input
) {
    await db.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
    const [clock] = await db.$queryRaw<
        { at: Date }[]
    >`SELECT clock_timestamp() AS at`;
    if (!clock) throw new Error('Missing observation clock.');
    const observedAt = clock.at;
    const hourCount = { '24H': 24, '7D': 168, '30D': 720 }[input.window];
    const currentHour = new Date(
        Math.floor(observedAt.getTime() / hour) * hour
    );
    const windowStart = new Date(
        currentHour.getTime() - (hourCount - 1) * hour
    );
    const retainedFrom = new Date(currentHour.getTime() - 719 * hour);
    const [organization, tracking, aggregates] = await Promise.all([
        db.organization.findUnique({
            where: { id: organizationId },
            select: { id: true },
        }),
        db.organizationRagTelemetry.findUnique({ where: { organizationId } }),
        readAggregates(db, organizationId, windowStart, currentHour),
    ]);
    if (!organization) throw new ORPCError('NOT_FOUND');
    const { dimensions, hours, phases, failures } = aggregates;
    if (!tracking && (dimensions.length || hours.length))
        throw new Error('Missing recorded tracking marker.');
    const hourRows = new Map(
        hours.map((row) => [row.bucketStart!.getTime(), row])
    );
    const result = telemetrySummary.parse({
        observedAt,
        windowStart,
        windowEnd: observedAt,
        retainedFrom,
        hourCount,
        coverage: 'BEST_EFFORT',
        state: tracking
            ? dimensions.length
                ? 'RECORDED'
                : 'NO_RECORDED_ACTIVITY'
            : 'NOT_TRACKED',
        tracking: {
            trackingSince: tracking?.trackingSince ?? null,
            lastRecordedAt: tracking?.lastRecordedAt ?? null,
            knownGapReports: tracking?.knownGapReports.toString() ?? '0',
            lastKnownGapReportedAt: tracking?.lastKnownGapReportedAt ?? null,
        },
        totals: tracking ? mapCounters(sumCounters(dimensions)) : null,
        hourly: Array.from({ length: hourCount }, (_, index) => {
            const bucketStart = new Date(windowStart.getTime() + index * hour);
            const row = hourRows.get(bucketStart.getTime());
            const notTracked =
                !tracking ||
                bucketStart.getTime() + hour <=
                    tracking.trackingSince.getTime();
            return {
                bucketStart,
                state: row
                    ? 'RECORDED'
                    : notTracked
                      ? 'NOT_TRACKED'
                      : 'NO_RECORDED_ACTIVITY',
                counters: row
                    ? mapCounters(row)
                    : notTracked
                      ? null
                      : mapCounters(sumCounters([])),
            };
        }),
        dimensions: dimensions.map((row) => ({
            workload: row.workload,
            provider: row.provider,
            counters: mapCounters(row),
            phases: phases
                .filter(
                    (phase) =>
                        phase.workload === row.workload &&
                        phase.provider === row.provider
                )
                .map(mapPhase)
                .filter((phase) => phase !== null),
            failures: failures
                .filter(
                    (failure) =>
                        failure.workload === row.workload &&
                        failure.provider === row.provider
                )
                .map((failure) => ({
                    code: failure.code,
                    count: failure.count,
                })),
        })),
    });
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2_097_152)
        throw new Error('Recorded response exceeds its bound.');
    return result;
}

/** Session-only organization technical activity, rechecked after the captured read. */
export function getTelemetryOverview(context: AuthorizedContext, input: Input) {
    return sanitized(async () => {
        const parsed = telemetryInput.parse(input);
        const result = await context.db.$transaction(
            async (tx) => {
                const actor = await ragActor(
                    context,
                    tx,
                    { ragQuota: ['read'] },
                    true
                );
                return snapshot(tx, actor.organizationId, parsed);
            },
            { isolationLevel: 'RepeatableRead', timeout: 10_000 }
        );
        await ragActor(context, context.db, { ragQuota: ['read'] }, true);
        return result;
    });
}

/** The calling superadmin guard owns authority; this read never exposes content IDs. */
export function getTelemetrySummary(
    db: PrismaClient,
    organizationId: string,
    input: Input
) {
    return sanitized(() =>
        db.$transaction(
            (tx) => snapshot(tx, organizationId, telemetryInput.parse(input)),
            { isolationLevel: 'RepeatableRead', timeout: 10_000 }
        )
    );
}

/** Three shared lane rows describe recent evidence from some process, not global health. */
export function getWorkerObservations(db: PrismaClient) {
    return sanitized(async () => {
        const result = await db.$transaction(
            async (tx) => {
                await tx.$executeRaw`SET LOCAL statement_timeout='5000ms'`;
                const [clock] = await tx.$queryRaw<
                    { at: Date }[]
                >`SELECT clock_timestamp() AS at`;
                if (!clock) throw new Error('Missing observation clock.');
                const rows = await tx.ragWorkerLaneObservation.findMany({
                    take: 3,
                });
                const staleAfterSeconds = 60;
                return workerObservations.parse({
                    observedAt: clock.at,
                    staleAfterSeconds,
                    items: (
                        ['NOTIFICATIONS', 'DOCUMENTS', 'INDEXING'] as const
                    ).map((lane) => {
                        const row = rows.find((item) => item.lane === lane);
                        const evidence = [
                            row?.lastHeartbeatObservedAt,
                            row?.lastScanStartObservedAt,
                            row?.lastScanFinishObservedAt,
                        ].filter((date): date is Date => !!date);
                        const newest = evidence.length
                            ? Math.max(
                                  ...evidence.map((date) => date.getTime())
                              )
                            : null;
                        return {
                            lane,
                            state:
                                newest === null
                                    ? 'NEVER_OBSERVED'
                                    : clock.at.getTime() - newest >
                                        staleAfterSeconds * 1000
                                      ? 'STALE'
                                      : 'RECENT',
                            lastHeartbeatObservedAt:
                                row?.lastHeartbeatObservedAt ?? null,
                            lastScanStartObservedAt:
                                row?.lastScanStartObservedAt ?? null,
                            lastScanFinishObservedAt:
                                row?.lastScanFinishObservedAt ?? null,
                            lastFinishedScanStartObservedAt:
                                row?.lastFinishedScanStartObservedAt ?? null,
                            lastFinishedScanDurationMicros:
                                row?.lastFinishedScanDurationMicros?.toString() ??
                                null,
                            lastScanOutcome: row?.lastScanOutcome ?? null,
                            lastSafeFailure: row?.lastSafeFailure ?? null,
                        };
                    }),
                });
            },
            { isolationLevel: 'RepeatableRead', timeout: 10_000 }
        );
        return result;
    });
}
