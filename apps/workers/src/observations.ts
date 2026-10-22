import type { PrismaClient } from '@repo/db';
import { startRagTelemetry, type WorkerLane } from '@routers/rag/telemetry';

/** Bounded shared-lane evidence surrounds real scan callbacks, never individual task success. */
export function startWorkerObservations(db: PrismaClient) {
    const recorder = startRagTelemetry(db);
    const initialized = new Set<WorkerLane>();
    const heartbeat = setInterval(() => {
        for (const lane of initialized) recorder.heartbeat(lane);
    }, 15_000);
    heartbeat.unref();
    const maintenance = setInterval(() => {
        void recorder.prune();
    }, 60_000);
    maintenance.unref();
    return {
        ready(lane: WorkerLane) {
            initialized.add(lane);
            recorder.heartbeat(lane);
        },
        async scan<T>(
            lane: WorkerLane,
            operation: () => Promise<T>
        ): Promise<T> {
            const observation = recorder.startScan(lane);
            try {
                const result = await operation();
                observation.finish('RETURNED');
                return result;
            } catch (error) {
                observation.finish('THREW', 'SCAN_FAILED');
                throw error;
            }
        },
        /** Stop observation timers before the final bounded flush and Prisma disconnect. */
        async shutdown() {
            clearInterval(heartbeat);
            clearInterval(maintenance);
            await recorder.shutdown();
        },
    };
}
