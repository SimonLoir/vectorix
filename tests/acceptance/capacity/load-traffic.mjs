/** Pure finite workload/evidence arithmetic. No timers, promises, clients, files or resource actions. */
export const RUNTIME_DRAFT_ONLY = true;
export const TRAFFIC = Object.freeze({
    durationMicros: 180_000_000,
    drainDeadlineMicros: 300_000_000,
    pacedIntervalMicros: 200_000,
    clientsPerOrganization: 5,
    organizations: 2,
    maximumRequests: 10_000,
    minimumSamplesPerOrganizationMode: 100,
});
export const MODES = Object.freeze(['LEXICAL', 'VECTOR', 'HYBRID']);
export const HISTOGRAM_UPPER_MICROS = Object.freeze([
    1000,
    5000,
    10000,
    25000,
    50000,
    100000,
    250000,
    500000,
    1000000,
    2500000,
    5000000,
    10000000,
    30000000,
    90000000,
    300000000,
    null,
]);
const need = (condition, code) => {
    if (!condition) throw new Error(code);
};
const clock = (value) => Number.isSafeInteger(value) && value >= 0;
const org = (value) => value === 'A' || value === 'B';
const integer = (value) => {
    need(
        typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(value),
        'LOAD_DECIMAL'
    );
    const result = BigInt(value);
    need(result <= 9_223_372_036_854_775_807n, 'LOAD_DECIMAL_BOUND');
    return result;
};

/** Fixed1800 offers:900 per organization and300 per retrieval mode, before any observed results. */
export function pacedOffers() {
    const result = [];
    for (
        let sequence = 0;
        sequence < TRAFFIC.durationMicros / TRAFFIC.pacedIntervalMicros;
        sequence++
    ) {
        for (const organization of ['A', 'B'])
            result.push({
                id: `${organization}/${sequence}`,
                organization,
                sequence,
                dueMicros: sequence * TRAFFIC.pacedIntervalMicros,
                mode: MODES[sequence % MODES.length],
                language: sequence % 2 === 0 ? 'EN' : 'FR',
                queryOrdinal: sequence % 40,
                selectiveFilter: sequence % 4 === 3,
            });
    }
    return result;
}

/** Do not queue missed offers: a full interval of lateness or full organization drops that iteration. */
export function dueDecisions(offers, cursor, nowMicros, active) {
    need(
        Array.isArray(offers) &&
            offers.length === 1800 &&
            Number.isSafeInteger(cursor) &&
            cursor >= 0 &&
            cursor <= offers.length &&
            clock(nowMicros),
        'LOAD_SCHEDULE_INPUT'
    );
    need(orgCounts(active), 'LOAD_ACTIVE_COUNTS');
    const reserved = { ...active },
        decisions = [];
    while (cursor < offers.length && offers[cursor].dueMicros <= nowMicros) {
        const offer = offers[cursor++],
            latenessMicros = nowMicros - offer.dueMicros;
        const reason =
            nowMicros >= TRAFFIC.durationMicros
                ? 'WINDOW_CLOSED'
                : latenessMicros >= TRAFFIC.pacedIntervalMicros
                  ? 'LATE'
                  : reserved[offer.organization] >=
                      TRAFFIC.clientsPerOrganization
                    ? 'BUSY'
                    : null;
        if (reason === null) reserved[offer.organization]++;
        decisions.push({
            ...offer,
            offeredAtMicros: nowMicros,
            latenessMicros,
            action: reason === null ? 'DISPATCH' : 'DROP',
            reason,
        });
    }
    return { cursor, decisions };
}
const orgCounts = (value) =>
    value &&
    Object.keys(value).sort().join(',') === 'A,B' &&
    Object.values(value).every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= 5
    );

/** Explicit adapter events, not simulated wire activity. Adapter invokes begin immediately around its real RPC. */
export class RequestTrace {
    #requests = new Map();
    #clients = new Map();
    #transport = new Set();
    #lastMicros = 0;
    #peakSlots = 0;
    #peakSlotsByOrganization = { A: 0, B: 0 };
    #peakHTTP = 0;
    #peakHTTPByOrganization = { A: 0, B: 0 };
    #time(value) {
        need(
            clock(value) && value >= this.#lastMicros,
            'LOAD_NONMONOTONIC_CLOCK'
        );
        this.#lastMicros = value;
    }
    offer(value, observedAtMicros) {
        this.#time(observedAtMicros);
        need(
            value &&
                /^[AB]\/[0-9]{1,5}$/u.test(value.id) &&
                org(value.organization) &&
                value.id.startsWith(value.organization + '/') &&
                MODES.includes(value.mode) &&
                clock(value.dueMicros) &&
                !this.#requests.has(value.id) &&
                this.#requests.size < TRAFFIC.maximumRequests,
            'LOAD_OFFER'
        );
        this.#requests.set(value.id, {
            id: value.id,
            organization: value.organization,
            mode: value.mode,
            dueMicros: value.dueMicros,
            offeredAtMicros: observedAtMicros,
            state: 'OFFERED',
        });
    }
    drop(id, reason, observedAtMicros) {
        this.#time(observedAtMicros);
        const row = this.#requests.get(id);
        need(
            row?.state === 'OFFERED' &&
                ['LATE', 'BUSY', 'WINDOW_CLOSED', 'STOPPED'].includes(reason),
            'LOAD_DROP'
        );
        Object.assign(row, { state: 'DROPPED', reason });
    }
    begin(id, client, observedAtMicros) {
        this.#time(observedAtMicros);
        const row = this.#requests.get(id);
        need(
            row?.state === 'OFFERED' &&
                /^[AB][0-4]$/u.test(client) &&
                client[0] === row.organization &&
                !this.#clients.has(client) &&
                observedAtMicros >= row.dueMicros &&
                observedAtMicros < TRAFFIC.durationMicros,
            'LOAD_BEGIN'
        );
        Object.assign(row, {
            state: 'PROCESSING',
            client,
            startedAtMicros: observedAtMicros,
        });
        this.#clients.set(client, id);
        this.#transport.add(id);
        const active = this.active();
        const transport = this.transportActive();
        this.#peakSlots = Math.max(this.#peakSlots, this.#clients.size);
        this.#peakHTTP = Math.max(this.#peakHTTP, this.#transport.size);
        for (const organization of ['A', 'B']) {
            this.#peakSlotsByOrganization[organization] = Math.max(
                this.#peakSlotsByOrganization[organization],
                active[organization]
            );
            this.#peakHTTPByOrganization[organization] = Math.max(
                this.#peakHTTPByOrganization[organization],
                transport[organization]
            );
        }
    }
    responseBodyRead(id, observedAtMicros) {
        this.#time(observedAtMicros);
        const row = this.#requests.get(id);
        need(
            row?.state === 'PROCESSING' &&
                row.responseBodyReadAtMicros === undefined,
            'LOAD_RESPONSE'
        );
        row.responseBodyReadAtMicros = observedAtMicros;
        row.transportEndedAtMicros = observedAtMicros;
        this.#transport.delete(id);
    }
    finish(id, outcome, observedAtMicros) {
        this.#time(observedAtMicros);
        const row = this.#requests.get(id);
        need(
            row?.state === 'PROCESSING' &&
                ['SUCCESS', 'ERROR', 'TIMEOUT', 'SAFETY_FAILURE'].includes(
                    outcome
                ) &&
                (outcome !== 'SUCCESS' ||
                    row.responseBodyReadAtMicros !== undefined),
            'LOAD_FINISH'
        );
        Object.assign(row, {
            state: 'FINISHED',
            outcome,
            finishedAtMicros: observedAtMicros,
            transportEndedAtMicros:
                row.transportEndedAtMicros ?? observedAtMicros,
            httpDurationMicros:
                (row.responseBodyReadAtMicros ?? observedAtMicros) -
                row.startedAtMicros,
            validationMicros:
                row.responseBodyReadAtMicros === undefined
                    ? null
                    : observedAtMicros - row.responseBodyReadAtMicros,
        });
        this.#transport.delete(id);
        this.#clients.delete(row.client);
    }
    /** Scheduling slots stay occupied through validation; this is not HTTP concurrency. */
    active() {
        const result = { A: 0, B: 0 };
        for (const client of this.#clients.keys()) result[client[0]]++;
        return result;
    }
    /** Actual adapter transport intervals end at complete body read, or failure without one. */
    transportActive() {
        const result = { A: 0, B: 0 };
        for (const id of this.#transport)
            result[this.#requests.get(id).organization]++;
        return result;
    }
    snapshot() {
        const rows = [...this.#requests.values()].map((row) => ({ ...row }));
        return {
            evidenceKind: 'ADAPTER_EVENT_TRACE_NOT_WIRE_PROOF',
            requests: rows,
            offered: rows.length,
            dropped: rows.filter((row) => row.state === 'DROPPED').length,
            started: rows.filter((row) => row.startedAtMicros !== undefined)
                .length,
            finished: rows.filter((row) => row.state === 'FINISHED').length,
            offeredNotDispatched: rows.filter((row) => row.state === 'OFFERED')
                .length,
            occupiedSlots: this.#clients.size,
            peakOccupiedSlots: this.#peakSlots,
            peakOccupiedSlotsByOrganization: {
                ...this.#peakSlotsByOrganization,
            },
            transportInFlight: this.#transport.size,
            peakHTTPInFlight: this.#peakHTTP,
            peakHTTPInFlightByOrganization: { ...this.#peakHTTPByOrganization },
            afterDrainDeadline: rows.some(
                (row) =>
                    (row.finishedAtMicros ?? 0) > TRAFFIC.drainDeadlineMicros
            ),
        };
    }
}

/** Nearest-rank exact client samples, capped at10k; errors must remain in separate reported totals. */
export function exactPercentiles(values) {
    need(
        Array.isArray(values) &&
            values.length <= TRAFFIC.maximumRequests &&
            values.every(clock),
        'LOAD_SAMPLES'
    );
    if (!values.length)
        return { samples: 0, p50: null, p95: null, p99: null, maximum: null };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (percentile) =>
        sorted[Math.ceil((sorted.length * percentile) / 100) - 1];
    return {
        samples: sorted.length,
        p50: at(50),
        p95: at(95),
        p99: at(99),
        maximum: sorted.at(-1),
    };
}

/** Existing histogram deltas only; maxima and quantiles are never subtracted. */
export function internalP95(before, after, expectedSamples) {
    need(
        Number.isSafeInteger(expectedSamples) &&
            expectedSamples >= 100 &&
            expectedSamples <= 10000,
        'LOAD_SAMPLE_COVERAGE'
    );
    need(
        before &&
            after &&
            before.buckets?.length === 16 &&
            after.buckets?.length === 16,
        'LOAD_HISTOGRAM_SHAPE'
    );
    const count = integer(after.samples) - integer(before.samples);
    const sum = integer(after.sumMicros) - integer(before.sumMicros);
    const buckets = after.buckets.map(
        (value, index) => integer(value) - integer(before.buckets[index])
    );
    need(
        count === BigInt(expectedSamples) &&
            sum >= 0n &&
            buckets.every((value) => value >= 0n) &&
            buckets.reduce((a, b) => a + b, 0n) === count,
        'LOAD_HISTOGRAM_DELTA'
    );
    let minimum = 0n,
        maximum = 0n,
        open = false;
    for (const [index, value] of buckets.entries()) {
        const lower = index === 0 ? 0 : HISTOGRAM_UPPER_MICROS[index - 1] + 1;
        minimum += value * BigInt(lower);
        if (HISTOGRAM_UPPER_MICROS[index] === null) open ||= value > 0n;
        else maximum += value * BigInt(HISTOGRAM_UPPER_MICROS[index]);
    }
    need(sum >= minimum && (open || sum <= maximum), 'LOAD_HISTOGRAM_SUM');
    const rank = (count * 95n + 99n) / 100n;
    let cumulative = 0n,
        index = 0;
    for (; index < buckets.length; index++) {
        cumulative += buckets[index];
        if (cumulative >= rank) break;
    }
    const lower = index === 0 ? 0 : HISTOGRAM_UPPER_MICROS[index - 1] + 1;
    const upper = HISTOGRAM_UPPER_MICROS[index];
    return {
        samples: expectedSamples,
        rank: Number(rank),
        lowerMicros: lower,
        upperMicros: upper,
        decision:
            upper !== null && upper < 1000000
                ? 'PASS'
                : lower >= 1000000
                  ? 'FAIL'
                  : 'INCONCLUSIVE',
    };
}

/** Exact exclusive search-cohort reconciliation supplements, never upgrades, BEST_EFFORT telemetry. */
export function reconcileCohort(before, after, expectedRequests, native) {
    need(
        Number.isSafeInteger(expectedRequests) &&
            expectedRequests >= 100 &&
            expectedRequests <= 10000 &&
            typeof native === 'boolean',
        'LOAD_COHORT_SIZE'
    );
    const expected = {
        recordedStarts: expectedRequests,
        recordedSuccesses: expectedRequests,
        recordedFailures: 0,
        recordedDenials: 0,
        recordedContinuations: 0,
        recordedSupersessions: 0,
        nativeStarts: native ? expectedRequests : 0,
        nativeValidatedBatches: native ? expectedRequests : 0,
        validatedVectors: native ? expectedRequests : 0,
        nativeFailedBatches: 0,
    };
    need(
        before?.formatVersion === 1 && after?.formatVersion === 1,
        'LOAD_COHORT_FORMAT'
    );
    need(
        integer(after.knownGapReports) === integer(before.knownGapReports),
        'LOAD_COHORT_GAP'
    );
    need(
        integer(after.failureClassTotal) === integer(before.failureClassTotal),
        'LOAD_COHORT_FAILURE_CLASSES'
    );
    for (const [key, value] of Object.entries(expected))
        need(
            integer(after.counters[key]) - integer(before.counters[key]) ===
                BigInt(value),
            'LOAD_COHORT_COUNTERS'
        );
    for (const phase of ['SERVICE_TOTAL', 'INTERNAL_PHASE_UNION'])
        need(
            integer(after.phases[phase].samples) -
                integer(before.phases[phase].samples) ===
                BigInt(expectedRequests),
            'LOAD_COHORT_PHASES'
        );
    need(
        integer(after.phases.QUERY_EMBED.samples) -
            integer(before.phases.QUERY_EMBED.samples) ===
            BigInt(native ? expectedRequests : 0),
        'LOAD_COHORT_QUERY_PHASE'
    );
    return internalP95(
        before.phases.INTERNAL_PHASE_UNION,
        after.phases.INTERNAL_PHASE_UNION,
        expectedRequests
    );
}
