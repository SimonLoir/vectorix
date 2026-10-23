/** Guarded traffic orchestration. Import constructs no clients, files, timers, SDKs or services. */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    pacedOffers,
    dueDecisions,
    RequestTrace,
    exactPercentiles,
    MODES,
    TRAFFIC,
} from './load-traffic.mjs';
import { need, digest, same } from './load-observer-core.mjs';
import {
    tinySource,
    ingestTiny,
    serialTrafficApi,
    INGEST_OFFSETS,
} from './load-traffic-ingestion.mjs';
import { evaluateLoadSearch } from './load-traffic-latency.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateIdentity } from './load-observer-core.mjs';
import { loadResourcePolicyHash } from './load-import-core.mjs';
import { observationPolicy } from './load-observer-core.mjs';
import {
    assertObservationBinding,
    observationBinding,
} from './load-observer-policy.mjs';
export const STATIC_DRAFT_ONLY = false;
export const TRAFFIC_RUNTIME_HELPERS = Object.freeze([
    'load-policy-registry.mjs',
    'load-observer-policy.mjs',
    'load-traffic-runtime.mjs',
    'load-traffic.mjs',
    'load-traffic-ingestion.mjs',
    'load-traffic-oracle.mjs',
    'load-traffic-latency.mjs',
    'load-traffic-catalog.mjs',
    'load-traffic-private.mjs',
    'load-traffic-resources.mjs',
    'load-traffic-sources.mjs',
    'load-traffic-inventory.mjs',
    'load-traffic-composition.mjs',
    'load-traffic-async-guard.mjs',
    'load-traffic-resource-worker.mjs',
    'load-traffic-ingestion-observer.mjs',
    'load-traffic-ingestion-observer-history.mjs',
    'load-traffic-ingestion-observer-sql.mjs',
    'load-traffic-ingestion-observer-runtime.mjs',
]);
const safeError = (error) =>
    [
        'LOAD_TIMEOUT',
        'LOAD_CANCELLED',
        'LOAD_AUTH',
        'LOAD_HTTP',
        'LOAD_RPC',
        'LOAD_BUDGET',
        'LOAD_CONCURRENCY',
    ].includes(error?.code)
        ? error.code
        : 'LOAD_TRAFFIC_FAILED';
/** Wait a real five-second observation gap without extending the phase's original drain deadline. */
export async function waitTrafficStableWindow({
    now,
    sleep,
    check,
    sampledAt,
    deadline,
}) {
    const target = sampledAt + 5000000;
    need(
        Number.isSafeInteger(sampledAt) &&
            Number.isSafeInteger(deadline) &&
            target <= deadline,
        'LOAD_OBS_TRAFFIC_DEADLINE'
    );
    let previous = sampledAt,
        wakes = 0;
    while (true) {
        check();
        const before = now();
        need(
            Number.isSafeInteger(before) &&
                before >= previous &&
                before <= deadline,
            'LOAD_OBS_TRAFFIC_DEADLINE'
        );
        const remaining = target - before;
        if (remaining <= 0) return;
        need(++wakes <= 64, 'LOAD_OBS_TRAFFIC_DEADLINE');
        await sleep(Math.ceil(remaining / 1000) * 1000);
        check();
        previous = now();
        need(
            Number.isSafeInteger(previous) &&
                previous >= before &&
                previous <= deadline,
            'LOAD_OBS_TRAFFIC_DEADLINE'
        );
    }
}
/** Async context binds each immutable normal transport event to its own offer despite same-role overlap. */
export function trafficEventBridge(trace, { now, origin, check }) {
    const local = new AsyncLocalStorage();
    return {
        run: (binding, callback) => local.run(binding, callback),
        onEvent(event) {
            if (event.operation !== 'indexing.search') return;
            const bound = local.getStore();
            need(
                bound &&
                    event.role ===
                        (bound.organization === 'A' ? 'owner' : 'foreign'),
                'LOAD_OBS_TRAFFIC_EVENT'
            );
            const relative = event.atMicros - origin;
            need(
                Number.isSafeInteger(relative) &&
                    relative >= 0 &&
                    event.atMicros <= now() + 1000,
                'LOAD_OBS_TRAFFIC_EVENT'
            );
            if (event.type === 'BEGIN') {
                check();
                need(
                    bound.transportId === undefined &&
                        relative < TRAFFIC.durationMicros,
                    'LOAD_OBS_TRAFFIC_WINDOW'
                );
                bound.transportId = event.id;
                trace.begin(bound.id, bound.client, relative);
                bound.transportStarted = true;
            } else {
                need(bound.transportId === event.id, 'LOAD_OBS_TRAFFIC_EVENT');
                if (event.type === 'BODY')
                    trace.responseBodyRead(bound.id, relative);
                else need(event.type === 'END', 'LOAD_OBS_TRAFFIC_EVENT');
            }
        },
    };
}
/** Fixed gates never reinterpret a client-slot peak as actual HTTP overlap. */
export function phaseDecision(
    phase,
    trace,
    latency,
    ingestions,
    truncated,
    sourceCoverage = true
) {
    const failed = trace.requests.filter(
        (row) => row.outcome && row.outcome !== 'SUCCESS'
    ).length;
    if (
        failed ||
        trace.occupiedSlots ||
        trace.transportInFlight ||
        trace.afterDrainDeadline
    )
        return 'FAIL';
    if (truncated) return 'INCONCLUSIVE';
    if (ingestions.length !== 6 || ingestions.some((row) => !row.complete))
        return 'FAIL';
    if (phase === 'paced' && trace.dropped) return 'FAIL';
    if (
        phase === 'closed-loop' &&
        (trace.peakHTTPInFlight !== 10 ||
            trace.peakHTTPInFlightByOrganization.A !== 5 ||
            trace.peakHTTPInFlightByOrganization.B !== 5)
    )
        return 'FAIL';
    if (latency.status !== 'PASS')
        return latency.status === 'FAIL'
            ? 'FAIL'
            : latency.status === 'UNMEASURED'
              ? 'UNMEASURED'
              : 'INCONCLUSIVE';
    if (!sourceCoverage) return 'INCONCLUSIVE';
    return 'PASS';
}
/** One phase owns180s admission and300s absolute request/ingestion/latency drain, with no retry or catch-up. */
export async function executeTrafficPhase({
    phase,
    state,
    fixture,
    fullReport,
    oracle,
    io,
    priorIngestion = { A: [], B: [] },
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
}) {
    validateIdentity(state, fixture);
    need(
        ['paced', 'closed-loop'].includes(phase) &&
            typeof io.openSearch === 'function',
        'LOAD_OBS_TRAFFIC_INPUT'
    );
    await io.admit();
    await io.verifyImmutable(fullReport, {
        moment: 'BEFORE',
        ingestion: priorIngestion,
    }); // Separate bounded preflight proof, outside the measured phase.
    const nativeBaselines = {};
    for (const organization of ['A', 'B']) {
        const collection =
            fullReport.baseline.collections[
                organization === 'A' ? 'ingestionA' : 'ingestionB'
            ];
        const expected = observationBinding(state, fixture, {
            collectionRole: organization === 'A' ? 'ingestionA' : 'ingestionB',
            policySha256: state.experimentPolicySha256,
            organizationId:
                fixture.users[organization === 'A' ? 'owner' : 'foreign']
                    .organizationId,
        });
        assertObservationBinding(collection, expected);
        nativeBaselines[organization] = await io.ingestionObserver.begin({
            phase,
            organizationId:
                fixture.users[organization === 'A' ? 'owner' : 'foreign']
                    .organizationId,
            ...fullReport.baseline.collections[
                organization === 'A' ? 'ingestionA' : 'ingestionB'
            ],
        });
    }
    const trace = new RequestTrace(),
        held = new Set(),
        tasks = new Set(),
        ingestions = [],
        errors = [],
        sources = new Map(),
        searchResults = Object.fromEntries(
            ['A', 'B'].flatMap((organization) =>
                MODES.map((mode) => [
                    organization + '/' + mode,
                    {
                        organization,
                        mode,
                        queries: 0,
                        empty: 0,
                        nonempty: 0,
                        vectorUnderfilled: 0,
                        parentUnderfilled: 0,
                        unfiltered: 0,
                        filtered: 0,
                        lexicalControlsEligible: 0,
                        lexicalControlsPassed: 0,
                        lexicalControlsFailed: 0,
                        minimumEligibleChildren: null,
                        maximumEligibleChildren: 0,
                    },
                ])
            )
        );
    let origin = null,
        stop = false,
        truncated = false,
        searches = 0,
        sequence = { A: 0, B: 0 },
        seenIngestion = new Set();
    const check = (allowCapStop = false) => {
        io.assertSafe();
        need(!stop || (allowCapStop && truncated), 'LOAD_OBS_TRAFFIC_STOPPED');
        if (origin !== null)
            need(
                io.now() - origin <= TRAFFIC.drainDeadlineMicros,
                'LOAD_OBS_TRAFFIC_DEADLINE'
            );
    };
    const adjustedBridge = trafficEventBridge(trace, {
        now: () => io.now() - (origin ?? 0),
        origin: 0,
        check: () => check(true),
    });
    const search = await io.openSearch({
        phase,
        onEvent: (event) =>
            origin === null
                ? need(
                      event.operation !== 'indexing.search',
                      'LOAD_OBS_TRAFFIC_EVENT'
                  )
                : adjustedBridge.onEvent({
                      ...event,
                      atMicros: event.atMicros - origin,
                  }),
    });
    const before = await io.latency.snapshot();
    await io.journal({
        kind: 'PHASE_PREPARED',
        phase,
        beforeSha256: digest(before),
        scheduleSha256: oracle.scheduleSha256,
    });
    const measurement = await io.beginMeasurements({
        runId: state.runId,
        phase,
        collectionId: fullReport.collections.primary.collectionId,
    });
    origin = io.now();
    const deadline = origin + TRAFFIC.drainDeadlineMicros;
    io.setDeadline?.(deadline);
    const serial = serialTrafficApi(io.ingestionApi, {
        check: () => check(true),
        maximumCalls: 2500,
    });
    const elapsed = () => Math.max(0, io.now() - origin);
    const launch = (offer, client) => {
        trace.offer(offer, elapsed());
        held.add(client);
        searches++;
        const binding = {
            id: offer.id,
            client,
            organization: offer.organization,
        };
        const promise = adjustedBridge.run(binding, async () => {
            let began = false;
            try {
                check(true);
                const request = oracle.request(offer);
                await io.journal({
                    kind: 'SEARCH_INTENT',
                    phase,
                    id: offer.id,
                    client,
                    organization: offer.organization,
                    mode: offer.mode,
                    dueMicros: offer.dueMicros,
                    requestSha256: digest(request),
                });
                check(true);
                const result = await search.call(
                    offer.organization === 'A' ? 'owner' : 'foreign',
                    'indexing.search',
                    request
                );
                began = binding.transportStarted === true;
                need(
                    result.http.requestId === binding.transportId &&
                        result.http.status === 200,
                    'LOAD_OBS_TRAFFIC_RESPONSE'
                );
                const validated = oracle.validate(offer, result.value),
                    sourceKey = offer.organization + '/' + offer.mode;
                if (validated.source && !sources.has(sourceKey))
                    sources.set(sourceKey, validated.source);
                const aggregate = searchResults[sourceKey];
                aggregate.queries++;
                aggregate[
                    validated.safe.results === 0 ? 'empty' : 'nonempty'
                ]++;
                aggregate.vectorUnderfilled += Number(
                    validated.safe.vectorUnderfilled === true
                );
                aggregate.parentUnderfilled += Number(
                    validated.safe.parentUnderfilled === true
                );
                aggregate[
                    validated.safe.unfiltered ? 'unfiltered' : 'filtered'
                ]++;
                if (Number.isSafeInteger(validated.safe.eligibleChildren)) {
                    aggregate.minimumEligibleChildren = Math.min(
                        aggregate.minimumEligibleChildren ??
                            validated.safe.eligibleChildren,
                        validated.safe.eligibleChildren
                    );
                    aggregate.maximumEligibleChildren = Math.max(
                        aggregate.maximumEligibleChildren,
                        validated.safe.eligibleChildren
                    );
                }
                if (validated.safe.lexicalPositiveControl?.eligible) {
                    aggregate.lexicalControlsEligible++;
                    aggregate[
                        validated.safe.lexicalPositiveControl.hit
                            ? 'lexicalControlsPassed'
                            : 'lexicalControlsFailed'
                    ]++;
                    need(
                        validated.safe.lexicalPositiveControl.hit,
                        'LOAD_OBS_LEXICAL_POSITIVE_CONTROL'
                    );
                }
                await io.onValidated?.(validated.safe);
                trace.finish(offer.id, 'SUCCESS', elapsed());
                binding.finished = true;
                await io.journal({
                    kind: 'SEARCH_FINISHED',
                    phase,
                    id: offer.id,
                    outcome: 'SUCCESS',
                    http: result.http,
                    responseSha256: digest(validated.safe),
                });
            } catch (error) {
                began = binding.transportStarted === true;
                errors.push({ id: offer.id, code: safeError(error) });
                if (!binding.finished) {
                    if (began)
                        trace.finish(
                            offer.id,
                            error?.code === 'LOAD_TIMEOUT'
                                ? 'TIMEOUT'
                                : 'SAFETY_FAILURE',
                            elapsed()
                        );
                    else trace.drop(offer.id, 'STOPPED', elapsed());
                }
                stop = true;
            } finally {
                held.delete(client);
            }
        });
        tasks.add(promise);
        void promise.then(
            () => tasks.delete(promise),
            () => {
                tasks.delete(promise);
                errors.push({
                    id: offer.id,
                    code: 'LOAD_TRAFFIC_TRACE_FAILED',
                });
                stop = true;
            }
        );
    };
    const dispatchIngestion = () => {
        for (let index = 0; index < 3; index++)
            if (elapsed() >= INGEST_OFFSETS[index])
                for (const organization of ['A', 'B']) {
                    const key = organization + '/' + index;
                    if (seenIngestion.has(key) || stop) continue;
                    seenIngestion.add(key);
                    const collection =
                        fullReport.baseline.collections[
                            organization === 'A' ? 'ingestionA' : 'ingestionB'
                        ];
                    const task = ingestTiny({
                        runId: state.runId,
                        phase,
                        organization,
                        index,
                        collection,
                        api: serial,
                        now: io.now,
                        sleep: io.sleep,
                        deadline,
                        journal: (value) => io.journal({ ...value, phase }),
                    }).then(
                        (value) =>
                            ingestions.push({
                                organization,
                                index,
                                complete: true,
                                ...value,
                            }),
                        (error) => {
                            errors.push({
                                id: 'ingestion/' + key,
                                code: safeError(error),
                            });
                            stop = true;
                        }
                    );
                    tasks.add(task);
                    void task.then(
                        () => tasks.delete(task),
                        () => {
                            tasks.delete(task);
                            stop = true;
                        }
                    );
                }
    };
    let resource,
        after,
        latency = { status: 'UNMEASURED', pairs: [] },
        ingestionProofs = {};
    try {
        if (phase === 'paced') {
            const offers = pacedOffers();
            let cursor = 0;
            while (elapsed() < TRAFFIC.durationMicros && !stop) {
                check();
                dispatchIngestion();
                const active = { A: 0, B: 0 };
                for (const client of held) active[client[0]]++;
                const due = dueDecisions(offers, cursor, elapsed(), active);
                cursor = due.cursor;
                for (const offer of due.decisions)
                    if (offer.action === 'DROP') {
                        trace.offer(offer, elapsed());
                        trace.drop(offer.id, offer.reason, elapsed());
                    } else {
                        const client = Array.from(
                            { length: 5 },
                            (_, index) => offer.organization + index
                        ).find((id) => !held.has(id));
                        need(client, 'LOAD_OBS_TRAFFIC_SLOTS');
                        launch(offer, client);
                    }
                await io.sleep(20000);
            }
            while (cursor < offers.length) {
                const offer = offers[cursor++];
                trace.offer(offer, elapsed());
                trace.drop(
                    offer.id,
                    stop ? 'STOPPED' : 'WINDOW_CLOSED',
                    elapsed()
                );
            }
        } else {
            while (elapsed() < TRAFFIC.durationMicros && !stop) {
                check();
                dispatchIngestion();
                for (const organization of ['A', 'B'])
                    for (let slot = 0; slot < 5; slot++) {
                        const client = organization + slot;
                        if (held.has(client)) continue;
                        if (searches >= TRAFFIC.maximumRequests) {
                            truncated = true;
                            stop = true;
                            break;
                        }
                        const ordinal = sequence[organization]++;
                        launch(
                            {
                                id: organization + '/' + ordinal,
                                organization,
                                sequence: ordinal,
                                dueMicros: elapsed(),
                                mode: MODES[ordinal % 3],
                                language: ordinal % 2 ? 'FR' : 'EN',
                                queryOrdinal: ordinal % 40,
                                selectiveFilter: ordinal % 4 === 3,
                            },
                            client
                        );
                    }
                await io.sleep(20000);
            }
        }
        // Accepted work is never cancelled or relabeled; keep collecting actual completions until the fixed deadline.
        while (tasks.size && elapsed() <= TRAFFIC.drainDeadlineMicros)
            await io.sleep(20000);
        need(
            tasks.size === 0 && elapsed() <= TRAFFIC.drainDeadlineMicros,
            'LOAD_OBS_TRAFFIC_DEADLINE'
        );
        while (io.now() + 5000000 <= deadline) {
            after = await io.latency.snapshot();
            const sampledAt = io.now();
            await waitTrafficStableWindow({
                now: io.now,
                sleep: io.sleep,
                check: () => check(true),
                sampledAt,
                deadline,
            });
            const stable = await io.latency.snapshot();
            need(
                io.now() - sampledAt >= 5000000 && io.now() <= deadline,
                'LOAD_OBS_TRAFFIC_DEADLINE'
            );
            if (same(after, stable)) {
                latency = evaluateLoadSearch({
                    before,
                    after: stable,
                    fixture,
                    trace: trace.snapshot(),
                });
                if (
                    latency.status !== 'UNMEASURED' ||
                    errors.length ||
                    truncated
                )
                    break;
            }
        }
        for (const organization of ['A', 'B']) {
            const current = ingestions.filter(
                (row) => row.organization === organization
            );
            if (truncated && current.length !== 3) {
                ingestionProofs[organization] = {
                    status: 'INCOMPLETE_CAP_STOP',
                    newPublishedDocuments: current.length,
                };
                continue;
            }
            need(current.length === 3, 'LOAD_OBS_INGEST_INCOMPLETE');
            ingestionProofs[organization] = await io.ingestionObserver.finish({
                phase,
                baselineRef: nativeBaselines[organization],
                organizationId:
                    fixture.users[organization === 'A' ? 'owner' : 'foreign']
                        .organizationId,
                ...fullReport.baseline.collections[
                    organization === 'A' ? 'ingestionA' : 'ingestionB'
                ],
                priorBindings: priorIngestion[organization].map(
                    (row) => row.binding ?? row
                ),
                newBindings: current.map((row) => row.binding),
                descriptors: [
                    ...priorIngestion[organization].map(
                        (row) => row.descriptor
                    ),
                    ...current.map((row) => row.descriptor),
                ],
                deadlineMicros: deadline,
            });
            need(io.now() <= deadline, 'LOAD_OBS_TRAFFIC_DEADLINE');
            const proof = ingestionProofs[organization];
            assertObservationBinding(
                proof,
                observationBinding(state, fixture, {
                    collectionRole:
                        organization === 'A' ? 'ingestionA' : 'ingestionB',
                    policySha256: state.experimentPolicySha256,
                    organizationId:
                        fixture.users[
                            organization === 'A' ? 'owner' : 'foreign'
                        ].organizationId,
                })
            );
            need(
                proof?.kind === 'INGESTION_PHASE_PROOF' &&
                    proof.runId === state.runId &&
                    proof.phase === phase &&
                    proof.newPublishedDocuments === 3 &&
                    proof.currentDocuments ===
                        priorIngestion[organization].length + 3 &&
                    proof.sourceTuplesVerified &&
                    proof.canonicalLayoutVerified &&
                    proof.physicalManifestsVerified &&
                    proof.accountingVerified &&
                    proof.noCurrentFailures &&
                    proof.cleanupHealth === 'CLEAN' &&
                    proof.failedOutstandingCleanupTasks === 0,
                'LOAD_OBS_INGEST_PROOF'
            );
        }
    } catch (error) {
        errors.push({ id: 'phase', code: safeError(error) });
        stop = true;
    } finally {
        resource = await measurement
            .finish()
            .catch(() => ({ status: 'FAILED' }));
        if (
            resource.oom !== false ||
            resource.processLost !== false ||
            resource.safetyReserveBreached !== false ||
            (evidenceKind === 'LIVE_NATIVE_ISOLATED' &&
                !(
                    resource.kind === 'INDEPENDENT_RESOURCE_SAMPLES' &&
                    resource.evidenceKind === 'LIVE_READ_ONLY' &&
                    resource.runId === state.runId &&
                    resource.phase === phase &&
                    resource.collectionId ===
                        fullReport.collections.primary.collectionId &&
                    resource.resourcePolicySha256 ===
                        loadResourcePolicyHash(state) &&
                    Number.isSafeInteger(resource.samples) &&
                    resource.samples >= 2 &&
                    resource.samples <= 20000 &&
                    Number.isSafeInteger(resource.durationMs) &&
                    resource.durationMs > 0 &&
                    Number.isSafeInteger(resource.minimumFreeBytes) &&
                    resource.minimumFreeBytes >=
                        state.loadPolicy.minimumFreeBytes &&
                    Number.isSafeInteger(resource.peakMemoryBytes) &&
                    resource.peakMemoryBytes > 0 &&
                    resource.measurementPurpose === 'TRAFFIC' &&
                    resource.rawPrimitivePhaseTag === 'full' &&
                    resource.samplerThread &&
                    /^[a-f0-9]{64}$/u.test(resource.rawSummarySha256)
                ))
        )
            errors.push({
                id: 'resources',
                code: 'LOAD_TRAFFIC_RESOURCE_FAILED',
            });
        if (elapsed() > TRAFFIC.drainDeadlineMicros)
            errors.push({
                id: 'phase-deadline',
                code: 'LOAD_TRAFFIC_DEADLINE',
            });
        if (tasks.size === 0) search.close();
    }
    let postProof = false,
        sourceProofs = [];
    if (tasks.size === 0)
        try {
            io.beginPostProof?.();
            postProof = await io.verifyImmutable(fullReport, {
                moment: 'AFTER',
                ingestion: Object.fromEntries(
                    ['A', 'B'].map((organization) => [
                        organization,
                        [
                            ...priorIngestion[organization],
                            ...ingestions
                                .filter(
                                    (row) => row.organization === organization
                                )
                                .map((row) => ({
                                    binding: row.binding,
                                    descriptor: row.descriptor,
                                })),
                        ],
                    ])
                ),
            });
            need(postProof === true, 'LOAD_OBS_PRIMARY_CHANGED');
            sourceProofs = await io.followSources(
                [...sources.values()],
                oracle
            );
            need(
                sourceProofs.length === sources.size &&
                    sourceProofs.every((row) => row.verified === true),
                'LOAD_OBS_SOURCE_PROOF'
            );
        } catch {
            errors.push({
                id: 'post-proof',
                code: 'LOAD_TRAFFIC_PROOF_FAILED',
            });
        }
    const snapshot = trace.snapshot(),
        decision = errors.length
            ? 'FAIL'
            : phaseDecision(
                  phase,
                  snapshot,
                  latency,
                  ingestions,
                  truncated,
                  sources.size === 6
              );
    const report = {
        schemaVersion: 1,
        namespace: state.namespace,
        experimentPolicyId: state.experimentPolicyId,
        policySha256: state.experimentPolicySha256,
        runId: state.runId,
        phase,
        evidenceKind,
        status: decision,
        capacityAcceptance:
            evidenceKind === 'LIVE_NATIVE_ISOLATED' ? decision : 'NOT_RUN',
        searches,
        trace: snapshot,
        errors,
        latency,
        ingestion: ingestions.map(({ descriptor, ...row }) => ({
            ...row,
            sourceSha256: descriptor.originalSha256,
        })),
        ingestionProofs,
        resource,
        harness: io.harnessSummary?.() ?? null,
        primaryUnchanged: postProof === true,
        sourceProofs,
        sourceCoverage: {
            requiredOrganizationModePairs: 6,
            provenNonemptyPairs: sources.size,
            complete: sources.size === 6,
        },
        searchResults: Object.values(searchResults),
        scheduleSha256: oracle.scheduleSha256,
        clientHTTP: exactPercentiles(
            snapshot.requests
                .filter((row) => row.httpDurationMicros !== undefined)
                .map((row) => row.httpDurationMicros)
        ),
        validation: exactPercentiles(
            snapshot.requests
                .filter(
                    (row) =>
                        row.validationMicros !== null &&
                        row.validationMicros !== undefined
                )
                .map((row) => row.validationMicros)
        ),
    };
    await io.finishEvidence(report);
    return report;
}
/** Actual root CLI must additionally load private one-shot context and reviewed concrete adapters. */
export async function loadTrafficRuntime(options) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    return executeTrafficPhase(options);
}
export function parseLoadTrafficArgs(args) {
    need(
        Array.isArray(args) &&
            args.length === 6 &&
            args[0] === '--state' &&
            path.isAbsolute(args[1]) &&
            args[2] === '--run' &&
            /^[a-f0-9]{12}$/u.test(args[3]) &&
            args[4] === '--mode' &&
            args[5] === 'traffic',
        'LOAD_OBS_TRAFFIC_ARGUMENTS'
    );
    return { statePath: args[1], runId: args[3], mode: 'traffic' };
}
/** One-shot orchestration; an existing invocation is refused before any client or phase is constructed. */
export async function executeLoadTrafficWorkflow({
    state,
    fixture,
    fullReport,
    oracle,
    prepareOracle,
    io,
    createPhaseIO,
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
}) {
    validateIdentity(state, fixture);
    need(
        ['SYNTHETIC_UNIT_TEST', 'LIVE_NATIVE_ISOLATED'].includes(
            evidenceKind
        ) && typeof createPhaseIO === 'function',
        'LOAD_OBS_TRAFFIC_INPUT'
    );
    need(
        fullReport?.status === 'COMPLETE' &&
            fullReport.workflow === 'full' &&
            fullReport.runId === state.runId &&
            fullReport.evidenceKind === evidenceKind &&
            fullReport.experimentPolicyId === state.experimentPolicyId &&
            fullReport.policySha256 === state.experimentPolicySha256 &&
            fullReport.corpusSha256 ===
                observationPolicy(state).identity.full &&
            fullReport.collections.primary.activeChildren === 100000 &&
            fullReport.collections.primary.parents === 25000 &&
            fullReport.fullObservation.validatedNativeVectors === 100000 &&
            fullReport.fullObservation.resourcePolicySha256 ===
                loadResourcePolicyHash(state),
        'LOAD_OBS_FULL_REPORT'
    );
    if (evidenceKind === 'LIVE_NATIVE_ISOLATED')
        need(
            fullReport.acceptance === 'FULL_INDEX_PREPARED',
            'LOAD_OBS_FULL_REPORT'
        );
    await io.admit();
    for (const name of [
        'load-traffic-invocation.json',
        'load-traffic-prepared.json',
        'load-traffic-report.json',
        'load-traffic-outcome.json',
    ])
        await io.assertAbsent(name);
    await io.writeJson(
        'load-traffic-invocation.json',
        {
            schemaVersion: 1,
            namespace: state.namespace,
            runId: state.runId,
            status: 'ADMITTED',
            fullReportSha256: digest(fullReport),
            preparation: 'PENDING_CANONICAL_AND_STORE_VERIFICATION',
            evidenceKind,
        },
        true
    );
    // An interrupted preload is an admitted one-shot invocation, never an invitation to replay mutations.
    try {
        if (!oracle) {
            need(
                typeof prepareOracle === 'function',
                'LOAD_OBS_TRAFFIC_COMPOSITION_REQUIRED'
            );
            oracle = await prepareOracle();
        }
        need(
            typeof oracle.request === 'function' &&
                typeof oracle.validate === 'function' &&
                /^[a-f0-9]{64}$/u.test(oracle.scheduleSha256),
            'LOAD_OBS_TRAFFIC_COMPOSITION_REQUIRED'
        );
        await io.writeJson(
            'load-traffic-prepared.json',
            {
                schemaVersion: 1,
                namespace: state.namespace,
                runId: state.runId,
                fullReportSha256: digest(fullReport),
                scheduleSha256: oracle.scheduleSha256,
                evidenceKind,
                status: 'PREPARED',
            },
            true
        );
    } catch {
        await io.writeJson(
            'load-traffic-outcome.json',
            {
                runId: state.runId,
                status: 'INCOMPLETE',
                capacityAcceptance: 'NOT_RUN',
                diagnostic: 'LOAD_TRAFFIC_PREPARATION_FAILED',
            },
            true
        );
        throw new Error('LOAD_OBS_TRAFFIC_PREPARATION_FAILED');
    }
    const phases = [];
    let priorIngestion = { A: [], B: [] },
        failure = false;
    try {
        for (const phase of ['paced', 'closed-loop']) {
            if (failure) break;
            const phaseIO = await createPhaseIO({ phase, priorIngestion });
            try {
                const report = await executeTrafficPhase({
                    phase,
                    state,
                    fixture,
                    fullReport,
                    oracle,
                    io: phaseIO,
                    priorIngestion,
                    evidenceKind,
                });
                phases.push(report);
                failure = report.status !== 'PASS';
                for (const organization of ['A', 'B'])
                    priorIngestion[organization].push(
                        ...report.ingestion
                            .filter((row) => row.organization === organization)
                            .map((row) => ({
                                binding: row.binding,
                                descriptor: {
                                    ...tinySource(
                                        state.runId,
                                        phase,
                                        organization,
                                        row.index
                                    ),
                                    text: undefined,
                                },
                            }))
                    );
            } finally {
                await phaseIO.close?.();
            }
        }
    } catch {
        await io.writeJson(
            'load-traffic-outcome.json',
            {
                runId: state.runId,
                status: 'INCOMPLETE',
                capacityAcceptance: 'NOT_RUN',
                diagnostic: 'LOAD_TRAFFIC_PHASE_INCOMPLETE',
            },
            true
        );
        throw new Error('LOAD_OBS_TRAFFIC_PHASE_INCOMPLETE');
    }
    const status =
        phases.length === 2 && phases.every((row) => row.status === 'PASS')
            ? 'PASS'
            : phases.some((row) => row.status === 'FAIL')
              ? 'FAIL'
              : phases.some((row) => row.status === 'INCONCLUSIVE')
                ? 'INCONCLUSIVE'
                : phases.some((row) => row.status === 'UNMEASURED')
                  ? 'UNMEASURED'
                  : 'INCOMPLETE';
    const report = {
        schemaVersion: 1,
        namespace: state.namespace,
        runId: state.runId,
        experimentPolicyId: state.experimentPolicyId,
        policySha256: state.experimentPolicySha256,
        evidenceKind,
        status,
        capacityAcceptance:
            evidenceKind === 'LIVE_NATIVE_ISOLATED' ? status : 'NOT_RUN',
        phases,
        fullReportSha256: digest(fullReport),
    };
    await io.writeJson('load-traffic-report.json', report, true);
    await io.writeJson(
        'load-traffic-outcome.json',
        {
            runId: state.runId,
            status,
            capacityAcceptance: report.capacityAcceptance,
            reportSha256: digest(report),
        },
        true
    );
    return report;
}
/** Guarded root composition seam. It cannot silently exit successfully when the concrete CLI adapter is still absent. */
export async function runLoadTrafficCli(
    args = process.argv.slice(2),
    createContext
) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    const parsed = parseLoadTrafficArgs(args);
    if (!createContext) {
        const { createLoadTrafficContext } =
            await import('./load-traffic-composition.mjs');
        createContext = (value) =>
            createLoadTrafficContext(value, TRAFFIC_RUNTIME_HELPERS);
    }
    need(
        typeof createContext === 'function',
        'LOAD_OBS_TRAFFIC_COMPOSITION_REQUIRED'
    );
    const context = await createContext(parsed);
    try {
        return await executeLoadTrafficWorkflow(context);
    } finally {
        await context.close?.();
    }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    runLoadTrafficCli()
        .then((report) =>
            console.log(
                JSON.stringify({
                    runId: report.runId,
                    status: report.status,
                    capacityAcceptance: report.capacityAcceptance,
                })
            )
        )
        .catch(() => {
            console.error(
                JSON.stringify({
                    completed: false,
                    diagnostic: 'LOAD_TRAFFIC_NOT_RUN_OR_INCOMPLETE',
                    capacityAcceptance: 'NOT_RUN',
                })
            );
            process.exitCode = 1;
        });
