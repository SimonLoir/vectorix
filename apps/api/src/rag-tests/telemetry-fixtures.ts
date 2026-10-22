import assert from 'node:assert/strict';
import { prisma, type Prisma } from '@repo/db';
import type { VectorixApiV1Outputs } from '@repo/api';
import { getRagTelemetry } from '@routers/rag/telemetry';
import { fixture as f } from './fixtures';
import { createOperationsFixture } from './operations-fixtures';

export type TelemetryView =
    VectorixApiV1Outputs['admin']['rag']['telemetry']['summary'];
export const telemetryHour = 3_600_000;
export const telemetryOnePhase = {
    samples: '1',
    sumMicros: '1001',
    maxMicros: '1001',
    buckets: ['0', '1', ...Array.from({ length: 14 }, () => '0')],
};

/** Fresh synthetic actors/organization; real native HTTP remains controlled, never a quality/billing claim. */
export async function createTelemetryFixture(label: string) {
    // The app-only HTTP test harness has no API-index lifecycle timer. Earlier
    // suites can fill the 256-delta/256-gap buffer; one flush is bounded to four
    // transactions and must never be mistaken for a full history drain.
    for (let pass = 0; pass < 16; pass++) await getRagTelemetry(prisma).flush();
    return createOperationsFixture(`Telemetry ${label}`);
}

/** Historical aggregation fixtures are explicitly synthetic; no actual task completion or usage ledger is forged. */
export async function seedTelemetryMarker(hours = 24) {
    const [clock] = await prisma.$queryRaw<
        { at: Date }[]
    >`SELECT clock_timestamp() AS at`;
    assert(clock);
    const currentHour = new Date(
        Math.floor(clock.at.getTime() / telemetryHour) * telemetryHour
    );
    const trackingSince = new Date(
        currentHour.getTime() - (hours - 1) * telemetryHour
    );
    await prisma.organizationRagTelemetry.create({
        data: {
            organizationId: f.org,
            trackingSince,
            lastRecordedAt: clock.at,
        },
    });
    return { now: clock.at, currentHour, trackingSince };
}

/** Each row is bounded and uses a valid atomic native success when native subtotals are present. */
export function seedTelemetryHour(
    bucketStart: Date,
    values: Omit<
        Prisma.RagOperationalHourUncheckedCreateInput,
        'organizationId' | 'bucketStart' | 'lastRecordedAt'
    >,
    lastRecordedAt = new Date(bucketStart.getTime() + 1000)
) {
    return prisma.ragOperationalHour.create({
        data: {
            organizationId: f.org,
            bucketStart,
            lastRecordedAt,
            ...values,
        },
    });
}

/** Native usage is observational and cannot be mistaken for searchable cardinality or complete money totals. */
export function dimension(
    view: TelemetryView,
    workload: TelemetryView['dimensions'][number]['workload']
) {
    const value = view.dimensions.find((row) => row.workload === workload);
    assert(value, `Missing recorded workload ${workload}.`);
    return value;
}
