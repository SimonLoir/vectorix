/** Numeric, sampled pending evidence; no Redis/Prisma clients or I/O on import. */
import { need } from '../s3-outage/private.mjs';

export const REDIS_PENDING_LIMITS = Object.freeze({
    minimumMilliseconds: 15_000,
    maximumMilliseconds: 60_000,
    minimumSnapshots: 3,
    maximumSnapshots: 12,
    intervalMilliseconds: 2_000,
});
const hash = (value) =>
    typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

/** Require explicit UTC offsets; never infer a timezone or modify saved dates. */
export function redisInstant(value) {
    need(
        typeof value === 'string' &&
            value.length <= 64 &&
            /(?:Z|\+00:00)$/u.test(value) &&
            Number.isFinite(Date.parse(value)),
        'S3_OUTAGE_REDIS_TIMESTAMP'
    );
    return Date.parse(value);
}

/** Bound synchronous child guards and transaction waits by the same outer deadline. */
export function redisRemainingMilliseconds(deadline, now = performance.now()) {
    const remaining = Math.floor(deadline - now);
    need(
        Number.isFinite(remaining) && remaining >= 2,
        'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE'
    );
    return remaining;
}

/** Prisma acquisition and execution share the remaining budget; original maxima stay unchanged. */
export function redisSnapshotBudget(remaining) {
    need(
        Number.isSafeInteger(remaining) && remaining >= 2,
        'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE'
    );
    const maxWait = Math.min(1000, Math.floor(remaining / 2));
    return { maxWait, timeout: Math.min(15000, remaining - maxWait) };
}

/**
 * Reconcile sampled, unchanged PENDING observations after the actual Redis stop.
 * This is not a universal no-scan barrier or continuous liveness observation.
 * Attempts may not be rewritten to make an in-flight native scan fit the trial.
 */
export function validateRedisPendingTrace(points, binding) {
    need(
        Array.isArray(points) &&
            points.length >= REDIS_PENDING_LIMITS.minimumSnapshots &&
            points.length <= REDIS_PENDING_LIMITS.maximumSnapshots &&
            id(binding?.versionId) &&
            hash(binding.originalSha256) &&
            hash(binding.originalBindingSha256) &&
            typeof binding.reservedBytes === 'string' &&
            /^[1-9]\d{0,8}$/u.test(binding.reservedBytes) &&
            Number.isSafeInteger(binding.workerPid) &&
            binding.workerPid > 1 &&
            typeof binding.workerStartTicks === 'string' &&
            /^\d{1,30}$/u.test(binding.workerStartTicks) &&
            hash(binding.redisContainerId),
        'S3_OUTAGE_REDIS_PENDING_SCOPE'
    );
    const stoppedAt = redisInstant(binding.stoppedAt),
        acceptedCreatedAt = redisInstant(binding.createdAt),
        acceptedStoredAt = redisInstant(binding.storedAt),
        stagedObservedAt = redisInstant(binding.stagedObservedAt);
    need(
        acceptedCreatedAt <= acceptedStoredAt &&
            acceptedStoredAt <= stagedObservedAt &&
            stagedObservedAt <= stoppedAt,
        'S3_OUTAGE_REDIS_PENDING_PRECUT_ACCEPTANCE'
    );
    let previous = null,
        previousElapsed = null;
    for (const row of points) {
        const at = redisInstant(row?.observedAt),
            createdAt = redisInstant(row?.createdAt),
            storedAt = redisInstant(row?.storedAt);
        need(
            at >= stoppedAt &&
                Number.isFinite(row.elapsedMilliseconds) &&
                row.elapsedMilliseconds >= 0 &&
                (previousElapsed === null
                    ? row.elapsedMilliseconds === 0
                    : row.elapsedMilliseconds - previousElapsed >=
                      REDIS_PENDING_LIMITS.intervalMilliseconds) &&
                (previous === null ||
                    at - previous >= REDIS_PENDING_LIMITS.intervalMilliseconds),
            'S3_OUTAGE_REDIS_PENDING_ORDER'
        );
        need(
            row.versionId === binding.versionId &&
                row.originalSha256 === binding.originalSha256 &&
                row.originalBindingSha256 === binding.originalBindingSha256 &&
                row.reservedBytes === binding.reservedBytes &&
                row.workerPid === binding.workerPid &&
                row.workerStartTicks === binding.workerStartTicks &&
                row.redisContainerId === binding.redisContainerId &&
                row.redisRunning === false &&
                row.workerRunning === true &&
                row.status === 'PROCESSING' &&
                row.ingestionStatus === 'PENDING' &&
                row.attempts === 0 &&
                row.tokenCount === 0 &&
                row.leasedUntil === null &&
                row.extractionPresent === false &&
                createdAt === acceptedCreatedAt &&
                storedAt === acceptedStoredAt &&
                storedAt <= at,
            'S3_OUTAGE_REDIS_PENDING_CHANGED_INCOMPLETE'
        );
        previous = at;
        previousElapsed = row.elapsedMilliseconds;
    }
    const wallDuration =
        redisInstant(points.at(-1).observedAt) -
        redisInstant(points[0].observedAt);
    need(
        wallDuration >= REDIS_PENDING_LIMITS.minimumMilliseconds &&
            wallDuration <= REDIS_PENDING_LIMITS.maximumMilliseconds &&
            previousElapsed >= REDIS_PENDING_LIMITS.minimumMilliseconds &&
            previousElapsed <= REDIS_PENDING_LIMITS.maximumMilliseconds,
        'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE'
    );
    return {
        snapshots: points.length,
        wallObservedMilliseconds: wallDuration,
        monotonicObservedMilliseconds: previousElapsed,
        attempts: 0,
        claimTokenCount: 0,
        interpretation: 'SAMPLED_PENDING_NOT_A_UNIVERSAL_SCAN_BARRIER',
    };
}
