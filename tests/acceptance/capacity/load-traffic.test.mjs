/** Synthetic clocks and counters only; never drives a timer, process, request or model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    pacedOffers,
    dueDecisions,
    RequestTrace,
    exactPercentiles,
    internalP95,
    reconcileCohort,
    RUNTIME_DRAFT_ONLY,
    TRAFFIC,
} from './load-traffic.mjs';

test('fixed180s paced plan offers5rps perorg with balanced300samples per mode', () => {
    const offers = pacedOffers();
    assert.equal(offers.length, 1800);
    for (const organization of ['A', 'B']) {
        const rows = offers.filter((row) => row.organization === organization);
        assert.equal(rows.length, 900);
        assert.equal(rows.at(-1).dueMicros, 179800000);
        for (const mode of ['LEXICAL', 'VECTOR', 'HYBRID']) {
            const selected = rows.filter((row) => row.mode === mode);
            assert.equal(selected.length, 300);
            assert.equal(
                selected.filter((row) => row.language === 'EN').length,
                150
            );
        }
    }
});
test('missed paced slots drop visibly without catchup bursts or hidden queues', () => {
    const result = dueDecisions(pacedOffers(), 0, 450000, { A: 0, B: 0 });
    assert.equal(result.cursor, 6);
    assert.equal(
        result.decisions.filter((row) => row.reason === 'LATE').length,
        4
    );
    assert.equal(
        result.decisions.filter((row) => row.action === 'DISPATCH').length,
        2
    );
    assert.deepEqual(
        dueDecisions(pacedOffers(), 0, 0, { A: 5, B: 0 }).decisions.map(
            (row) => row.reason
        ),
        ['BUSY', null]
    );
    const ended = dueDecisions(pacedOffers(), 0, 180000000, { A: 0, B: 0 });
    assert.equal(ended.decisions.length, 1800);
    assert.ok(ended.decisions.every((row) => row.reason === 'WINDOW_CLOSED'));
});
test('ten simultaneous adapter request events are5perorg, not merely configured clients', () => {
    const trace = new RequestTrace();
    for (const organization of ['A', 'B'])
        for (let slot = 0; slot < 5; slot++) {
            const id = organization + '/' + slot;
            trace.offer({ id, organization, mode: 'VECTOR', dueMicros: 0 }, 0);
            trace.begin(id, organization + slot, 0);
        }
    assert.deepEqual(trace.active(), { A: 5, B: 5 });
    assert.deepEqual(trace.transportActive(), { A: 5, B: 5 });
    assert.equal(trace.snapshot().peakHTTPInFlight, 10);
    assert.equal(trace.snapshot().peakOccupiedSlots, 10);
    assert.deepEqual(trace.snapshot().peakHTTPInFlightByOrganization, {
        A: 5,
        B: 5,
    });
    for (const row of trace.snapshot().requests) {
        trace.responseBodyRead(row.id, 1000);
        trace.finish(row.id, 'SUCCESS', 1000);
    }
    assert.equal(trace.snapshot().transportInFlight, 0);
    assert.equal(trace.snapshot().occupiedSlots, 0);
    assert.equal(trace.snapshot().finished, 10);
});
test('completed response followed by long validation does not inflate HTTP overlap', () => {
    const trace = new RequestTrace();
    trace.offer(
        { id: 'A/0', organization: 'A', mode: 'VECTOR', dueMicros: 0 },
        0
    );
    trace.begin('A/0', 'A0', 0);
    trace.responseBodyRead('A/0', 10);
    trace.offer(
        { id: 'A/1', organization: 'A', mode: 'VECTOR', dueMicros: 0 },
        20
    );
    trace.begin('A/1', 'A1', 20);
    assert.equal(trace.snapshot().peakHTTPInFlight, 1);
    assert.equal(trace.snapshot().peakOccupiedSlots, 2);
    assert.equal(trace.snapshot().transportInFlight, 1);
    assert.equal(trace.snapshot().occupiedSlots, 2);
    trace.finish('A/0', 'SUCCESS', 25);
    assert.equal(trace.snapshot().requests[0].transportEndedAtMicros, 10);
    trace.responseBodyRead('A/1', 30);
    trace.finish('A/1', 'SUCCESS', 40);
    assert.equal(trace.snapshot().peakHTTPInFlight, 1);
});
test('ten accumulated post-body validations cannot prove ten overlapping HTTP requests', () => {
    const trace = new RequestTrace();
    for (const [index, client] of [
        'A0',
        'A1',
        'A2',
        'A3',
        'A4',
        'B0',
        'B1',
        'B2',
        'B3',
        'B4',
    ].entries()) {
        const id = client[0] + '/' + index;
        trace.offer(
            { id, organization: client[0], mode: 'HYBRID', dueMicros: 0 },
            index * 10
        );
        trace.begin(id, client, index * 10);
        trace.responseBodyRead(id, index * 10 + 5);
    }
    const snapshot = trace.snapshot();
    assert.equal(snapshot.peakOccupiedSlots, 10);
    assert.deepEqual(snapshot.peakOccupiedSlotsByOrganization, { A: 5, B: 5 });
    assert.equal(snapshot.peakHTTPInFlight, 1);
    assert.deepEqual(snapshot.peakHTTPInFlightByOrganization, { A: 1, B: 1 });
    assert.equal(snapshot.transportInFlight, 0);
    for (const row of snapshot.requests) trace.finish(row.id, 'SUCCESS', 200);
    assert.equal(trace.snapshot().occupiedSlots, 0);
    assert.equal(trace.snapshot().peakHTTPInFlight, 1);
});
test('client reuse, duplicate completion, absent response, stale clock and unlaunched offers fail or stay explicit', () => {
    const trace = new RequestTrace();
    trace.offer(
        { id: 'A/0', organization: 'A', mode: 'HYBRID', dueMicros: 0 },
        0
    );
    trace.begin('A/0', 'A0', 10);
    trace.offer(
        { id: 'A/1', organization: 'A', mode: 'LEXICAL', dueMicros: 0 },
        10
    );
    assert.throws(() => trace.begin('A/1', 'A0', 10));
    assert.throws(() => trace.finish('A/0', 'SUCCESS', 11));
    assert.throws(() => trace.responseBodyRead('A/0', 9));
    trace.finish('A/0', 'TIMEOUT', 20);
    assert.equal(trace.snapshot().transportInFlight, 0);
    assert.equal(trace.snapshot().occupiedSlots, 0);
    assert.equal(trace.snapshot().requests[0].transportEndedAtMicros, 20);
    assert.throws(() => trace.finish('A/0', 'SUCCESS', 21));
    assert.equal(trace.snapshot().offeredNotDispatched, 1);
    assert.equal(trace.snapshot().requests[0].httpDurationMicros, 10);
});
test('body read timing separates response transport from later canonical validation', () => {
    const trace = new RequestTrace();
    trace.offer(
        { id: 'B/0', organization: 'B', mode: 'VECTOR', dueMicros: 0 },
        0
    );
    trace.begin('B/0', 'B0', 10);
    trace.responseBodyRead('B/0', 30);
    trace.finish('B/0', 'SUCCESS', 45);
    const row = trace.snapshot().requests[0];
    assert.equal(row.httpDurationMicros, 20);
    assert.equal(row.validationMicros, 15);
    assert.deepEqual(exactPercentiles([100, 300, 200, 500, 400]), {
        samples: 5,
        p50: 300,
        p95: 500,
        p99: 500,
        maximum: 500,
    });
    assert.throws(() => exactPercentiles([NaN]));
    assert.throws(() => exactPercentiles([-1]));
});
const upper = [
    1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2500000,
    5000000, 10000000, 30000000, 90000000, 300000000, 400000000,
];
const histogram = (count = 0, index = 0) => ({
    samples: String(count),
    sumMicros: String(count * upper[index]),
    buckets: Array.from({ length: 16 }, (_, i) =>
        i === index ? String(count) : '0'
    ),
});
test('strict p95 uses delta buckets; inclusive1s never proves below1s and maxima are not subtracted', () => {
    assert.equal(
        internalP95(histogram(), histogram(100, 7), 100).decision,
        'PASS'
    );
    assert.equal(
        internalP95(histogram(), histogram(100, 8), 100).decision,
        'INCONCLUSIVE'
    );
    assert.equal(
        internalP95(histogram(), histogram(100, 9), 100).decision,
        'FAIL'
    );
    const before = histogram(50, 0),
        after = histogram(50, 0);
    after.samples = '150';
    after.sumMicros = '50050000';
    after.buckets[7] = '100';
    assert.equal(internalP95(before, after, 100).upperMicros, 500000);
    assert.throws(() => internalP95(after, before, 100));
    assert.throws(() => internalP95(histogram(), histogram(99), 100));
    assert.throws(() => internalP95(histogram(), histogram(100), 99));
});
function cohort(count, native = true) {
    return {
        formatVersion: 1,
        knownGapReports: '0',
        failureClassTotal: '0',
        counters: {
            recordedStarts: String(count),
            recordedSuccesses: String(count),
            recordedFailures: '0',
            recordedDenials: '0',
            recordedContinuations: '0',
            recordedSupersessions: '0',
            nativeStarts: native ? String(count) : '0',
            nativeValidatedBatches: native ? String(count) : '0',
            validatedVectors: native ? String(count) : '0',
            nativeFailedBatches: '0',
        },
        phases: {
            SERVICE_TOTAL: histogram(count),
            INTERNAL_PHASE_UNION: histogram(count),
            QUERY_EMBED: histogram(native ? count : 0),
        },
    };
}
test('exclusive cohort requires every start/outcome/native/sample count and unchanged gaps', () => {
    assert.equal(
        reconcileCohort(cohort(0), cohort(100), 100, true).decision,
        'PASS'
    );
    assert.equal(
        reconcileCohort(cohort(0, false), cohort(100, false), 100, false)
            .decision,
        'PASS'
    );
    for (const mutate of [
        (value) => (value.knownGapReports = '1'),
        (value) => (value.counters.recordedFailures = '1'),
        (value) => (value.counters.validatedVectors = '99'),
        (value) => (value.counters.nativeFailedBatches = '1'),
        (value) => (value.phases.SERVICE_TOTAL.samples = '99'),
        (value) => (value.phases.INTERNAL_PHASE_UNION.buckets[0] = '99'),
        (value) => (value.failureClassTotal = '1'),
        (value) => (value.phases.QUERY_EMBED.samples = '99'),
        (value) => (value.phases.INTERNAL_PHASE_UNION.sumMicros = '10000000'),
    ]) {
        const after = cohort(100);
        mutate(after);
        assert.throws(() => reconcileCohort(cohort(0), after, 100, true));
    }
});
test('request trace never grows beyond10k and records missed300s drain instead of truncating time', () => {
    const bounded = new RequestTrace();
    for (let index = 0; index < 10000; index++) {
        const row = {
            id: `A/${index}`,
            organization: 'A',
            mode: 'LEXICAL',
            dueMicros: 0,
        };
        bounded.offer(row, 0);
        bounded.drop(row.id, 'STOPPED', 0);
    }
    assert.throws(() =>
        bounded.offer(
            { id: 'A/10000', organization: 'A', mode: 'VECTOR', dueMicros: 0 },
            0
        )
    );
    const late = new RequestTrace();
    late.offer(
        { id: 'B/0', organization: 'B', mode: 'HYBRID', dueMicros: 0 },
        0
    );
    late.begin('B/0', 'B0', 0);
    late.finish('B/0', 'TIMEOUT', 300000001);
    assert.equal(late.snapshot().afterDrainDeadline, true);
});
test('all exported policy remains draft and finite; decimals cannot round or overflow', () => {
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    assert.equal(TRAFFIC.maximumRequests, 10000);
    for (const value of ['01', '-1', '1.0', '1e3', '9223372036854775808']) {
        const after = cohort(100);
        after.knownGapReports = value;
        assert.throws(() => reconcileCohort(cohort(0), after, 100, true));
    }
});
