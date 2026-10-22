import type { PrismaClient } from '@repo/db';
import { RagTelemetryRecorder } from './recorder';

const recorders = new WeakMap<PrismaClient, RagTelemetryRecorder>();

/** One coalescer per process/client; merely observing does not open a timer or make I/O. */
export function getRagTelemetry(db: PrismaClient) {
    let recorder = recorders.get(db);
    if (!recorder) {
        recorder = new RagTelemetryRecorder(db);
        recorders.set(db, recorder);
    }
    return recorder;
}

/** Start process lifecycle once in API/workers; callers shut down before disconnecting Prisma. */
export function startRagTelemetry(db: PrismaClient) {
    return getRagTelemetry(db).startTimer();
}

export { RagTelemetryRecorder } from './recorder';
export type * from './types';
