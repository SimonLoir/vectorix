import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RagTelemetryRecorder, type TelemetryPersistence } from '../recorder';
import { intervalUnionMicros, mergeDelta, phaseSample } from '../numeric';
import type { TelemetryTags } from '../types';

const tags = (id = 'organization'): TelemetryTags => ({
    organizationId: id,
    workload: 'INDEX_SEMANTIC',
    provider: 'OLLAMA',
});
function storage() {
    const writes: Parameters<TelemetryPersistence['write']>[] = [],
        lanes: Parameters<TelemetryPersistence['lanes']>[] = [];
    const persistence: TelemetryPersistence = {
        write(...values) {
            writes.push(values);
            return Promise.resolve();
        },
        lanes(...values) {
            lanes.push(values);
            return Promise.resolve();
        },
        prune() {
            return Promise.resolve();
        },
    };
    return { writes, lanes, persistence };
}

void test('fixed integer histograms merge exact counts, attained maxima and nullable bytes', () => {
    let delta = mergeDelta(
        tags(),
        {},
        { phaseStats: { PLAN: phaseSample(1000) }, sourceReadBytes: 0n }
    );
    delta = mergeDelta(tags(), delta, {
        phaseStats: { PLAN: phaseSample(1001) },
        artifactWrittenBytes: 5n,
    });
    assert.equal(delta.phaseStats?.PLAN?.samples, 2n);
    assert.equal(delta.phaseStats?.PLAN?.sumMicros, 2001n);
    assert.equal(delta.phaseStats?.PLAN?.maxMicros, 1001n);
    assert.deepEqual(delta.phaseStats?.PLAN?.buckets.slice(0, 3), [1n, 1n, 0n]);
    assert.equal(delta.sourceReadBytes, 0n);
    assert.equal(delta.artifactWrittenBytes, 5n);
    assert.equal(mergeDelta(tags(), {}, {}).sourceReadBytes, undefined);
    assert.throws(() =>
        mergeDelta(
            tags(),
            { recordedStarts: 9_223_372_036_854_775_807n },
            { recordedStarts: 1n }
        )
    );
    assert.throws(() =>
        mergeDelta(tags(), {}, { knownBilledInputTokens: Number.NaN })
    );
});

void test('internal phase union preserves overlap with embedding and rejects unbounded geometry', () => {
    assert.equal(
        intervalUnionMicros([
            [0, 2],
            [1, 9],
            [2, 3],
            [8, 10],
            [12, 14],
        ]),
        12_000
    );
    assert.equal(intervalUnionMicros([[0, 0]]), 0);
    assert.equal(intervalUnionMicros([]), 0);
    assert.throws(() =>
        intervalUnionMicros(Array.from({ length: 6 }, () => [0, 1] as const))
    );
    assert.throws(() => intervalUnionMicros([[2, 1]]));
    assert.throws(() => intervalUnionMicros([[-1, 1]]));
});

void test('coalescer bounds256 tag deltas and256 gaps with fair bounded draining', async () => {
    const target = storage(),
        recorder = new RagTelemetryRecorder(target.persistence);
    for (let index = 0; index < 600; index++)
        recorder.observe(tags('org' + index), { recordedStarts: 1n });
    for (let pass = 0; pass < 10; pass++) await recorder.flush();
    const entries = target.writes.flatMap(([rows]) => rows),
        gaps = target.writes.flatMap(([, rows]) => rows);
    assert.equal(entries.length, 256);
    assert.equal(
        new Set(entries.map((entry) => entry.tags.organizationId)).size,
        256
    );
    assert.equal(gaps.length, 256);
    assert.ok(
        target.writes.every(
            ([rows, gapRows]) => rows.length + gapRows.length <= 16
        )
    );
});

void test('detached/inflight keys consume capacity and immutable flush values survive new observations', async () => {
    const target = storage();
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
    });
    let first = true;
    target.persistence.write = async (...values) => {
        target.writes.push(values);
        if (first) {
            first = false;
            await barrier;
        }
    };
    const recorder = new RagTelemetryRecorder(target.persistence);
    for (let index = 0; index < 256; index++)
        recorder.observe(tags('org' + index), { recordedStarts: 1n });
    const flushing = recorder.flush();
    assert.equal(recorder.flush(), flushing);
    recorder.observe(tags('newOrg'), { recordedStarts: 1n });
    recorder.observe(tags('org0'), { recordedStarts: 7n });
    assert.equal(target.writes[0]?.[0][0]?.delta.recordedStarts, 1n);
    release();
    await flushing;
    for (let pass = 0; pass < 8; pass++) await recorder.flush();
    assert.equal(
        target.writes
            .flatMap(([rows]) => rows)
            .reduce(
                (total, row) => total + (row.delta.recordedStarts ?? 0n),
                0n
            ),
        256n
    );
    assert.deepEqual(
        new Set(
            target.writes.flatMap(([, rows]) =>
                rows.map((row) => row.organizationId)
            )
        ),
        new Set(['newOrg', 'org0'])
    );
});

void test('unconfirmed writes are discarded once, reported as gaps and never replay operation totals', async () => {
    const target = storage();
    let reject = true;
    target.persistence.write = (...values) => {
        target.writes.push(values);
        return reject
            ? Promise.reject(new Error('Unconfirmed commit'))
            : Promise.resolve();
    };
    const recorder = new RagTelemetryRecorder(target.persistence);
    recorder.observe(tags(), { recordedStarts: 5n });
    await recorder.flush();
    reject = false;
    await recorder.flush();
    assert.equal(
        target.writes
            .flatMap(([rows]) => rows)
            .filter((row) => (row.delta.recordedStarts ?? 0n) > 0n).length,
        1
    );
    assert.ok(
        target.writes.some(([, rows]) =>
            rows.some((row) => row.organizationId === 'organization')
        )
    );
});

void test('native validated success is one atomic numeric delta with known-zero or explicit unknown usage', async () => {
    const target = storage(),
        recorder = new RagTelemetryRecorder(target.persistence),
        execution = recorder.start(tags());
    execution.nativeObserver({
        provider: 'OLLAMA',
        kind: 'document',
        inputCount: 1,
        preparedInputBytes: 20,
        outcome: 'VALIDATED',
        durationMicros: 100,
        validatedVectors: 1,
        estimatedInputTokens: 5,
        providerInputTokens: 0,
        billedInputTokens: null,
    });
    execution.finish('DENIED', 'ACCESS');
    await recorder.flush();
    const row = target.writes[0]?.[0][0]?.delta;
    assert.equal(row?.nativeValidatedBatches, 1n);
    assert.equal(row?.validatedVectors, 1n);
    assert.equal(row?.validatedPreparedBytes, 20n);
    assert.equal(row?.knownProviderInputTokens, 0n);
    assert.equal(row?.unknownProviderTokenBatches, 0n);
    assert.equal(row?.unknownBilledTokenBatches, 1n);
    assert.equal(row?.recordedDenials, 1n);
    assert.equal(row?.nativeFailedBatches, 0n);
});

void test('three lane slots coalesce heartbeats/scans without a detached promise queue or borrowed start', async () => {
    const target = storage(),
        recorder = new RagTelemetryRecorder(target.persistence);
    for (let pass = 0; pass < 1000; pass++) {
        for (const lane of ['NOTIFICATIONS', 'DOCUMENTS', 'INDEXING'] as const)
            recorder.heartbeat(lane);
    }
    const earlier = recorder.startScan('INDEXING');
    const later = recorder.startScan('INDEXING');
    earlier.finish('THREW', 'DATABASE_UNAVAILABLE');
    await recorder.flush();
    const rows = target.lanes[0]?.[0];
    assert.equal(rows?.length, 3);
    const indexed = rows?.find((row) => row.lane === 'INDEXING');
    assert.notEqual(indexed?.finish?.start, indexed?.start);
    assert.equal(indexed?.finish?.start.receipt, null);
    later.finish('RETURNED');
    await recorder.flush();
    assert.equal(target.lanes[1]?.[0][0]?.finish?.failure, null);
    await recorder.shutdown();
});
