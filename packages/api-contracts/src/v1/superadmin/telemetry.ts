import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
    telemetryCounter,
    telemetryWindow,
    telemetrySummary,
} from '../rag/telemetry';

export const getTelemetryContract = oc
    .route({
        method: 'GET',
        path: '/{organizationId}/telemetry',
        description:
            'Read organization technical activity without content or recovery access',
    })
    .input(
        z
            .object({
                organizationId: z.string().min(1),
                window: telemetryWindow.default('24H'),
            })
            .strict()
    )
    .output(telemetrySummary);

/** Shared lane observations are evidence from some worker, never universal health. */
export const workerObservations = z.object({
    observedAt: z.date(),
    staleAfterSeconds: z.number().int().positive(),
    items: z
        .array(
            z.object({
                lane: z.enum(['NOTIFICATIONS', 'DOCUMENTS', 'INDEXING']),
                state: z.enum(['NEVER_OBSERVED', 'RECENT', 'STALE']),
                lastHeartbeatObservedAt: z.date().nullable(),
                lastScanStartObservedAt: z.date().nullable(),
                lastScanFinishObservedAt: z.date().nullable(),
                lastFinishedScanStartObservedAt: z.date().nullable(),
                lastFinishedScanDurationMicros: telemetryCounter.nullable(),
                lastScanOutcome: z.enum(['RETURNED', 'THREW']).nullable(),
                lastSafeFailure: z
                    .enum([
                        'SCAN_FAILED',
                        'DATABASE_UNAVAILABLE',
                        'REDIS_UNAVAILABLE',
                        'UNKNOWN',
                    ])
                    .nullable(),
            })
        )
        .max(3),
});
export const getWorkerObservationsContract = oc
    .route({
        method: 'GET',
        path: '/worker-observations',
        description:
            'Inspect bounded shared worker lane evidence; platform administrator only',
    })
    .input(z.object({}).strict().prefault({}))
    .output(workerObservations);
