import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    redisInstant,
    validateRedisPendingTrace,
    redisRemainingMilliseconds,
    redisSnapshotBudget,
} from './pending.mjs';
import { advancedCompletedScan } from '../s3-outage/observe.mjs';

const start = Date.parse('2026-10-24T13:00:00.000Z');
function fixture() {
    const binding = {
        versionId: 'version-two',
        originalSha256: 'a'.repeat(64),
        originalBindingSha256: 'b'.repeat(64),
        reservedBytes: '620',
        workerPid: 4321,
        workerStartTicks: '987654321',
        redisContainerId: 'c'.repeat(64),
        stoppedAt: new Date(start).toISOString(),
        createdAt: new Date(start - 1000).toISOString(),
        storedAt: new Date(start - 500).toISOString(),
        stagedObservedAt: new Date(start - 250).toISOString(),
    };
    const points = [0, 8_000, 16_000].map((milliseconds) => ({
        ...binding,
        observedAt: new Date(start + 1000 + milliseconds).toISOString(),
        elapsedMilliseconds: milliseconds,
        createdAt: binding.createdAt,
        storedAt: binding.storedAt,
        redisRunning: false,
        workerRunning: true,
        status: 'PROCESSING',
        ingestionStatus: 'PENDING',
        attempts: 0,
        tokenCount: 0,
        leasedUntil: null,
        extractionPresent: false,
    }));
    return { binding, points };
}

test('sampled pending trace preserves explicit same-worker/store/version bindings', () => {
    const { binding, points } = fixture();
    assert.deepEqual(validateRedisPendingTrace(points, binding), {
        snapshots: 3,
        wallObservedMilliseconds: 16_000,
        monotonicObservedMilliseconds: 16_000,
        attempts: 0,
        claimTokenCount: 0,
        interpretation: 'SAMPLED_PENDING_NOT_A_UNIVERSAL_SCAN_BARRIER',
    });
});

test('an already admitted scan cannot be hidden by a later pending sample', () => {
    for (const delta of [
        { attempts: 1 },
        { ingestionStatus: 'PROCESSING' },
        { tokenCount: 1 },
        { leasedUntil: '2026-10-24T13:05:00Z' },
        { extractionPresent: true },
    ]) {
        const { binding, points } = fixture();
        Object.assign(points[1], delta);
        assert.throws(() => validateRedisPendingTrace(points, binding), {
            message: 'S3_OUTAGE_REDIS_PENDING_CHANGED_INCOMPLETE',
        });
    }
});

test('changing a source, reservation, container or worker refuses the scoped trial', () => {
    for (const delta of [
        { versionId: 'foreign-version' },
        { originalSha256: 'd'.repeat(64) },
        { originalBindingSha256: 'd'.repeat(64) },
        { reservedBytes: '0' },
        { workerPid: 4322 },
        { workerStartTicks: '12345' },
        { redisContainerId: 'd'.repeat(64) },
        { redisRunning: true },
        { workerRunning: false },
    ]) {
        const { binding, points } = fixture();
        Object.assign(points[1], delta);
        assert.throws(() => validateRedisPendingTrace(points, binding), {
            message: 'S3_OUTAGE_REDIS_PENDING_CHANGED_INCOMPLETE',
        });
    }
});

test('finite UTC parser admits the actual Python receipt offset and rejects naive time', () => {
    assert.equal(redisInstant('2026-10-24T13:00:00+00:00'), start);
    assert.equal(redisInstant('2026-10-24T13:00:00Z'), start);
    for (const value of [
        '2026-10-24T13:00:00',
        '2026-10-24T13:00:00+01:00',
        'not-a-timestampZ',
        null,
    ])
        assert.throws(() => redisInstant(value), {
            message: 'S3_OUTAGE_REDIS_TIMESTAMP',
        });
});

test('early, repeated or pre-stop observations cannot supply the pending window', () => {
    for (const milliseconds of [-1000, 1000, 2000]) {
        const { binding, points } = fixture();
        points[1].observedAt = new Date(start + milliseconds).toISOString();
        assert.throws(() => validateRedisPendingTrace(points, binding), {
            message: 'S3_OUTAGE_REDIS_PENDING_ORDER',
        });
    }
    const { binding, points } = fixture();
    points[2].observedAt = new Date(start + 14_000).toISOString();
    assert.throws(() => validateRedisPendingTrace(points, binding), {
        message: 'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE',
    });
});

test('snapshot and lifetime caps refuse rather than truncate or claim success', () => {
    const { binding, points } = fixture();
    assert.throws(() => validateRedisPendingTrace(points.slice(1), binding), {
        message: 'S3_OUTAGE_REDIS_PENDING_SCOPE',
    });
    assert.throws(
        () => validateRedisPendingTrace(Array(13).fill(points[0]), binding),
        {
            message: 'S3_OUTAGE_REDIS_PENDING_SCOPE',
        }
    );
    points[2].observedAt = new Date(start + 62_000).toISOString();
    assert.throws(() => validateRedisPendingTrace(points, binding), {
        message: 'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE',
    });
});

test('the exact accepted pre-cut created/stored tuple cannot drift or be replaced by post-cut acceptance', () => {
    for (const delta of [
        { createdAt: new Date(start - 999).toISOString() },
        { storedAt: new Date(start - 499).toISOString() },
        { createdAt: new Date(start + 1).toISOString() },
    ]) {
        const { binding, points } = fixture();
        Object.assign(points[0], delta);
        assert.throws(
            () => validateRedisPendingTrace(points, binding),
            /CHANGED_INCOMPLETE/u
        );
    }
    for (const delta of [
        { storedAt: new Date(start + 1).toISOString() },
        { stagedObservedAt: new Date(start + 1).toISOString() },
        { createdAt: new Date(start - 499).toISOString() },
    ]) {
        const { binding, points } = fixture();
        Object.assign(binding, delta);
        assert.throws(
            () => validateRedisPendingTrace(points, binding),
            /PRECUT_ACCEPTANCE/u
        );
    }
});

test('a wall-clock jump cannot replace fifteen actual monotonic seconds', () => {
    const { binding, points } = fixture();
    points[1].elapsedMilliseconds = 2000;
    points[2].elapsedMilliseconds = 4000;
    assert.throws(() => validateRedisPendingTrace(points, binding), {
        message: 'S3_OUTAGE_REDIS_PENDING_WINDOW_INCOMPLETE',
    });
});

test('latest completion advances even with BullMQ retention cardinality already saturated', () => {
    const before = {
        jobSha256: 'a'.repeat(64),
        completedAtMilliseconds: start,
    };
    const after = {
        jobSha256: 'b'.repeat(64),
        completedAtMilliseconds: start + 5000,
    };
    assert.equal(advancedCompletedScan(before, after), true);
    assert.equal(advancedCompletedScan(before, before), false);
    assert.equal(advancedCompletedScan(null, after), true);
    assert.equal(advancedCompletedScan(before, null), false);
    assert.equal(
        advancedCompletedScan(before, {
            ...after,
            completedAtMilliseconds: start - 1,
        }),
        false
    );
    assert.throws(() =>
        advancedCompletedScan(before, {
            jobSha256: 'raw-job',
            completedAtMilliseconds: start,
        })
    );
});

test('nested guard and transaction budgets use remaining time without refreshing the outer deadline', () => {
    assert.equal(redisRemainingMilliseconds(60_000, 59_500.1), 499);
    assert.deepEqual(redisSnapshotBudget(499), { maxWait: 249, timeout: 250 });
    assert.deepEqual(redisSnapshotBudget(60_000), {
        maxWait: 1000,
        timeout: 15000,
    });
    assert.equal(redisRemainingMilliseconds(60_000, 59_998), 2);
    for (const now of [59_998.1, 60_000, 60_001, NaN])
        assert.throws(() => redisRemainingMilliseconds(60_000, now));
    for (const remaining of [1, 0, Infinity, 2.5])
        assert.throws(() => redisSnapshotBudget(remaining));
});
