import { Prisma } from '@repo/db';
import { counterFields } from '../telemetry/types';

export const summedFields = [
    ...counterFields,
    'sourceReadBytes',
    'artifactWrittenBytes',
] as const;
export type AggregateRow = Record<
    (typeof summedFields)[number],
    string | null
> & {
    knownBilledInputTokens: number;
    bucketStart?: Date;
    workload?: string;
    provider?: string;
};
export type PhaseRow = {
    workload: string;
    provider: string;
    phase: string;
    samples: string;
    sumMicros: string;
    maxMicros: string;
    buckets: string[];
};
export type FailureRow = {
    workload: string;
    provider: string;
    code: string;
    count: string;
};

const sums = {
    recordedStarts: true,
    recordedSuccesses: true,
    recordedFailures: true,
    recordedContinuations: true,
    recordedSupersessions: true,
    recordedDenials: true,
    nativeStarts: true,
    nativeValidatedBatches: true,
    nativeFailedBatches: true,
    validatedVectors: true,
    dispatchedPreparedBytes: true,
    validatedPreparedBytes: true,
    validatedEstimatedInputTokens: true,
    knownProviderInputTokens: true,
    unknownProviderTokenBatches: true,
    unknownBilledTokenBatches: true,
    knownBilledInputTokens: true,
    sourceReadBytes: true,
    artifactWrittenBytes: true,
} as const;
type SumValues = Record<(typeof summedFields)[number], bigint | null> & {
    knownBilledInputTokens: number | null;
};
function scalarTotals(value: SumValues): AggregateRow {
    return {
        ...(Object.fromEntries(
            summedFields.map((field) => [
                field,
                value[field]?.toString() ?? null,
            ])
        ) as Record<(typeof summedFields)[number], string | null>),
        knownBilledInputTokens: value.knownBilledInputTokens ?? 0,
    };
}

/** Prisma owns scalar aggregates. SQL is needed to expand and aggregate fixed JSON histograms before API hydration. */
export async function readAggregates(
    db: Prisma.TransactionClient,
    organizationId: string,
    start: Date,
    end: Date
) {
    const where = Prisma.sql`"organizationId"=${organizationId} AND "bucketStart">=${start} AND "bucketStart"<=${end}`;
    const scalarWhere = {
        organizationId,
        bucketStart: { gte: start, lte: end },
    };
    const [hourGroups, dimensionGroups, phases, failures] = await Promise.all([
        db.ragOperationalHour.groupBy({
            by: ['bucketStart'],
            where: scalarWhere,
            _sum: sums,
            orderBy: { bucketStart: 'asc' },
        }),
        db.ragOperationalHour.groupBy({
            by: ['workload', 'provider'],
            where: scalarWhere,
            _sum: sums,
            orderBy: [{ workload: 'asc' }, { provider: 'asc' }],
        }),
        db.$queryRaw<PhaseRow[]>(Prisma.sql`
            WITH entries AS (
                SELECT workload,provider,phase.key AS phase,phase.value AS stats
                FROM "RagOperationalHour",LATERAL jsonb_each("phaseStats") phase WHERE ${where}
            ), totals AS (
                SELECT workload,provider,phase,SUM((stats->>'samples')::numeric)::text AS samples,
                SUM((stats->>'sumMicros')::numeric)::text AS "sumMicros",
                MAX((stats->>'maxMicros')::numeric)::text AS "maxMicros"
                FROM entries GROUP BY workload,provider,phase
            ), bins AS (
                SELECT workload,provider,phase,ordinality,SUM(value::numeric)::text AS count
                FROM entries,LATERAL jsonb_array_elements_text(stats->'buckets') WITH ORDINALITY
                GROUP BY workload,provider,phase,ordinality
            ) SELECT t.workload::text,t.provider::text,t.phase,t.samples,t."sumMicros",t."maxMicros",
                ARRAY_AGG(b.count ORDER BY b.ordinality) AS buckets
                FROM totals t JOIN bins b USING(workload,provider,phase)
                GROUP BY t.workload,t.provider,t.phase,t.samples,t."sumMicros",t."maxMicros"
                ORDER BY t.workload,t.provider,t.phase
        `),
        db.$queryRaw<FailureRow[]>(
            Prisma.sql`SELECT workload::text,provider::text,failure.key AS code,SUM(failure.value::numeric)::text AS count FROM "RagOperationalHour",LATERAL jsonb_each_text("failureCounts") failure WHERE ${where} GROUP BY workload,provider,failure.key ORDER BY workload,provider,failure.key`
        ),
    ]);
    const hours: AggregateRow[] = hourGroups.map((row) => ({
        bucketStart: row.bucketStart,
        ...scalarTotals(row._sum),
    }));
    const dimensions: AggregateRow[] = dimensionGroups.map((row) => ({
        workload: row.workload,
        provider: row.provider,
        ...scalarTotals(row._sum),
    }));
    if (
        hours.length > 720 ||
        dimensions.length > 27 ||
        phases.length > 216 ||
        failures.length > 324
    )
        throw new Error('Invalid bounded telemetry aggregation.');
    return { hours, dimensions, phases, failures };
}
