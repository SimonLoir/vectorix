import type { Prisma, PrismaClient } from '@repo/db';
import { encodeDelta } from './numeric';
import type {
    TelemetryDelta,
    TelemetryTags,
    WorkerFailure,
    WorkerLane,
} from './types';

export type PendingDelta = Readonly<{
    tags: TelemetryTags;
    delta: TelemetryDelta;
}>;
export type PendingGap = Readonly<{ organizationId: string }>;
export type ScanStart = { receipt: Date | null };
export type LaneWrite = Readonly<{
    lane: WorkerLane;
    heartbeat: boolean;
    start?: ScanStart;
    finish?: Readonly<{
        start: ScanStart;
        durationMicros: bigint;
        outcome: 'RETURNED' | 'THREW';
        failure: WorkerFailure | null;
    }>;
}>;
type Tx = Prisma.TransactionClient;

/** Marker row lock precedes database clock sampling, including competing process flushes. */
async function marker(tx: Tx, organizationId: string, gap: boolean) {
    await tx.$executeRaw`INSERT INTO "OrganizationRagTelemetry" ("organizationId","formatVersion","trackingSince","lastRecordedAt","knownGapReports")
        SELECT ${organizationId},1,t,t,0 FROM (SELECT clock_timestamp()::timestamptz(3) AS t) moment
        WHERE EXISTS (SELECT 1 FROM "organization" WHERE id=${organizationId})
        ON CONFLICT ("organizationId") DO NOTHING`;
    await tx.$queryRaw`SELECT "organizationId" FROM "OrganizationRagTelemetry" WHERE "organizationId"=${organizationId} FOR UPDATE`;
    const rows = await tx.$queryRaw<
        { observedAt: Date }[]
    >`WITH moment AS (SELECT clock_timestamp()::timestamptz(3) AS t)
        UPDATE "OrganizationRagTelemetry"
        SET "lastRecordedAt"=GREATEST("lastRecordedAt",moment.t),
            "knownGapReports"="knownGapReports"+${gap ? 1n : 0n},
            "lastKnownGapReportedAt"=CASE WHEN ${gap} THEN GREATEST("lastRecordedAt",moment.t) ELSE "lastKnownGapReportedAt" END
        FROM moment
        WHERE "organizationId"=${organizationId} RETURNING "lastRecordedAt" AS "observedAt"`;
    const row = rows[0];
    return row?.observedAt ?? null;
}

/**
 * Atomic fixed-column counters/histograms cannot be added through Prisma JSON operations.
 * Values are parameters; reviewed migration functions validate both JSON inputs and sums.
 * This transaction never takes task, source, member or semantic-accounting locks.
 */
async function addHour(tx: Tx, entry: PendingDelta, observedAt: Date) {
    const bucketStart = new Date(observedAt);
    bucketStart.setUTCMinutes(0, 0, 0);
    const row = JSON.stringify({
        ...encodeDelta(entry.delta),
        ...entry.tags,
        bucketStart,
        formatVersion: 1,
        lastRecordedAt: observedAt,
        sourceReadBytes: entry.delta.sourceReadBytes?.toString() ?? null,
        artifactWrittenBytes:
            entry.delta.artifactWrittenBytes?.toString() ?? null,
    });
    await tx.$executeRaw`INSERT INTO "RagOperationalHour"
      SELECT r.* FROM jsonb_populate_record(NULL::"RagOperationalHour",${row}::jsonb) AS r
      ON CONFLICT ("organizationId","bucketStart","workload","provider") DO UPDATE SET
      "lastRecordedAt"=GREATEST("RagOperationalHour"."lastRecordedAt",EXCLUDED."lastRecordedAt"),
      "recordedStarts"="RagOperationalHour"."recordedStarts"+EXCLUDED."recordedStarts",
      "recordedSuccesses"="RagOperationalHour"."recordedSuccesses"+EXCLUDED."recordedSuccesses",
      "recordedFailures"="RagOperationalHour"."recordedFailures"+EXCLUDED."recordedFailures",
      "recordedContinuations"="RagOperationalHour"."recordedContinuations"+EXCLUDED."recordedContinuations",
      "recordedSupersessions"="RagOperationalHour"."recordedSupersessions"+EXCLUDED."recordedSupersessions",
      "recordedDenials"="RagOperationalHour"."recordedDenials"+EXCLUDED."recordedDenials",
      "nativeStarts"="RagOperationalHour"."nativeStarts"+EXCLUDED."nativeStarts",
      "nativeValidatedBatches"="RagOperationalHour"."nativeValidatedBatches"+EXCLUDED."nativeValidatedBatches",
      "nativeFailedBatches"="RagOperationalHour"."nativeFailedBatches"+EXCLUDED."nativeFailedBatches",
      "validatedVectors"="RagOperationalHour"."validatedVectors"+EXCLUDED."validatedVectors",
      "dispatchedPreparedBytes"="RagOperationalHour"."dispatchedPreparedBytes"+EXCLUDED."dispatchedPreparedBytes",
      "validatedPreparedBytes"="RagOperationalHour"."validatedPreparedBytes"+EXCLUDED."validatedPreparedBytes",
      "validatedEstimatedInputTokens"="RagOperationalHour"."validatedEstimatedInputTokens"+EXCLUDED."validatedEstimatedInputTokens",
      "knownProviderInputTokens"="RagOperationalHour"."knownProviderInputTokens"+EXCLUDED."knownProviderInputTokens",
      "unknownProviderTokenBatches"="RagOperationalHour"."unknownProviderTokenBatches"+EXCLUDED."unknownProviderTokenBatches",
      "unknownBilledTokenBatches"="RagOperationalHour"."unknownBilledTokenBatches"+EXCLUDED."unknownBilledTokenBatches",
      "knownBilledInputTokens"="RagOperationalHour"."knownBilledInputTokens"+EXCLUDED."knownBilledInputTokens",
      "sourceReadBytes"=CASE WHEN EXCLUDED."sourceReadBytes" IS NULL THEN "RagOperationalHour"."sourceReadBytes" ELSE COALESCE("RagOperationalHour"."sourceReadBytes",0)+EXCLUDED."sourceReadBytes" END,
      "artifactWrittenBytes"=CASE WHEN EXCLUDED."artifactWrittenBytes" IS NULL THEN "RagOperationalHour"."artifactWrittenBytes" ELSE COALESCE("RagOperationalHour"."artifactWrittenBytes",0)+EXCLUDED."artifactWrittenBytes" END,
      "phaseStats"=vectorix_telemetry_merge_phases("RagOperationalHour"."phaseStats",EXCLUDED."phaseStats",EXCLUDED."workload"),
      "failureCounts"=vectorix_telemetry_merge_failures("RagOperationalHour"."failureCounts",EXCLUDED."failureCounts")`;
}

/** No automatic retry: a rejected/ambiguous telemetry commit is dropped, never replayed. */
export async function persistTelemetry(
    db: PrismaClient,
    entries: readonly PendingDelta[],
    gaps: readonly PendingGap[]
) {
    const organizations = [
        ...new Set([
            ...entries.map((entry) => entry.tags.organizationId),
            ...gaps.map((gap) => gap.organizationId),
        ]),
    ].toSorted();
    await db.$transaction(
        async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '50ms'`;
            for (const organizationId of organizations) {
                const observedAt = await marker(
                    tx,
                    organizationId,
                    gaps.some((gap) => gap.organizationId === organizationId)
                );
                if (!observedAt) continue; // A deleted organization is never recreated or retained as a poisoned gap key.
                for (const entry of entries.filter(
                    (value) => value.tags.organizationId === organizationId
                ))
                    await addHour(tx, entry, observedAt);
            }
        },
        { maxWait: 50, timeout: 250 }
    );
}

/** Three shared row slots, with a finish's own start receipt; another replica's start is never substituted. */
export async function persistLanes(
    db: PrismaClient,
    values: readonly LaneWrite[]
) {
    const starts = await db.$transaction(
        async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '50ms'`;
            const receipts: { start: ScanStart; observedAt: Date }[] = [];
            for (const value of values.toSorted((a, b) =>
                a.lane.localeCompare(b.lane)
            )) {
                await tx.$executeRaw`INSERT INTO "RagWorkerLaneObservation" ("lane") VALUES (${value.lane}::"RagWorkerLane") ON CONFLICT DO NOTHING`;
                await tx.$queryRaw`SELECT lane FROM "RagWorkerLaneObservation" WHERE lane=${value.lane}::"RagWorkerLane" FOR UPDATE`;
                const times = await tx.$queryRaw<
                    { observedAt: Date }[]
                >`SELECT GREATEST(clock_timestamp()::timestamptz(3),
                "lastHeartbeatObservedAt","lastScanStartObservedAt","lastScanFinishObservedAt") AS "observedAt"
                FROM "RagWorkerLaneObservation" WHERE lane=${value.lane}::"RagWorkerLane"`;
                const observedAt = times[0]?.observedAt;
                if (!observedAt)
                    throw new Error('Worker observation unavailable.');
                const finishStart =
                    value.finish?.start === value.start
                        ? observedAt
                        : (value.finish?.start.receipt ?? null);
                await tx.$executeRaw`UPDATE "RagWorkerLaneObservation" SET
                "lastHeartbeatObservedAt"=CASE WHEN ${value.heartbeat} THEN ${observedAt} ELSE "lastHeartbeatObservedAt" END,
                "lastScanStartObservedAt"=CASE WHEN ${Boolean(value.start)} THEN ${observedAt} ELSE "lastScanStartObservedAt" END,
                "lastScanFinishObservedAt"=CASE WHEN ${Boolean(value.finish)} THEN ${observedAt} ELSE "lastScanFinishObservedAt" END,
                "lastFinishedScanStartObservedAt"=CASE WHEN ${Boolean(value.finish)} THEN ${finishStart}::timestamptz ELSE "lastFinishedScanStartObservedAt" END,
                "lastFinishedScanDurationMicros"=CASE WHEN ${Boolean(value.finish)} THEN ${value.finish?.durationMicros ?? null}::bigint ELSE "lastFinishedScanDurationMicros" END,
                "lastScanOutcome"=CASE WHEN ${Boolean(value.finish)} THEN ${value.finish?.outcome ?? null}::"RagWorkerScanOutcome" ELSE "lastScanOutcome" END,
                "lastSafeFailure"=CASE WHEN ${Boolean(value.finish)} THEN ${value.finish?.failure ?? null}::"RagWorkerFailure" ELSE "lastSafeFailure" END
                WHERE lane=${value.lane}::"RagWorkerLane"`;
                if (value.start)
                    receipts.push({ start: value.start, observedAt });
            }
            return receipts;
        },
        { maxWait: 50, timeout: 250 }
    );
    // A rollback or unknown commit must not fabricate a successful local start receipt.
    for (const receipt of starts) receipt.start.receipt = receipt.observedAt;
}

/** Bounded expiry selection uses the time index; reads independently exclude expired buckets. */
export async function pruneTelemetry(db: PrismaClient) {
    await db.$transaction(
        async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '50ms'`;
            await tx.$executeRaw`DELETE FROM "RagOperationalHour" WHERE ctid IN (
            SELECT ctid FROM "RagOperationalHour"
            WHERE "bucketStart" < ((date_trunc('hour',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '719 hours')
            ORDER BY "bucketStart","organizationId" LIMIT 500 FOR UPDATE SKIP LOCKED)`;
        },
        { maxWait: 50, timeout: 250 }
    );
}
