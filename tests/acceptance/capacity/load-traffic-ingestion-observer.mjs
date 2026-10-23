/** Separate, injected traffic-ingestion proof. No file, client, timer or service is opened on import. */
import {
    validateIdentity,
    id,
    hash,
    digest,
    same,
    decimal,
    fields,
    stableNativeSnapshot,
} from './load-observer-core.mjs';
export const STATIC_DRAFT_ONLY = true;
export const INGESTION_LIMITS = Object.freeze({
    documents: 6,
    candidates: 64,
    chunks: 256,
    receiptBytes: 32768,
});
export class IngestionObservationError extends Error {
    constructor(code = 'LOAD_INGEST_OBSERVATION_FAILED') {
        super(
            /^LOAD_INGEST_[A-Z_]{1,64}$/u.test(code)
                ? code
                : 'LOAD_INGEST_OBSERVATION_FAILED'
        );
        this.code = this.message;
    }
}
export const need = (value, code) => {
    if (!value) throw new IngestionObservationError(code);
};

const keys = (value, names) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    same(Object.keys(value).sort(), [...names].sort());
const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 && value <= 256;
/** Refuse unexpected fields rather than persisting arbitrary reader data in a private evidence receipt. */
export function checkedIngestionCatalog(value) {
    need(
        keys(value, [
            'currentDocuments',
            'newPublishedDocuments',
            'newPublishedChildren',
            'sourceTuplesVerified',
            'canonicalLayoutVerified',
            'physicalManifestsVerified',
            'accountingVerified',
            'noCurrentFailures',
            'cleanupHealth',
            'failedOutstandingCleanupTasks',
            'retained',
            'accounting',
            'history',
            'manifestSha256',
        ]) &&
            [3, 6].includes(value.currentDocuments) &&
            value.newPublishedDocuments === 3 &&
            value.newPublishedChildren === 3 &&
            count(value.failedOutstandingCleanupTasks) &&
            value.cleanupHealth ===
                (value.failedOutstandingCleanupTasks
                    ? 'UNRESOLVED_FAILED_CLEANUP'
                    : 'CLEAN') &&
            [
                'sourceTuplesVerified',
                'canonicalLayoutVerified',
                'physicalManifestsVerified',
                'accountingVerified',
                'noCurrentFailures',
            ].every((key) => value[key] === true) &&
            hash(value.manifestSha256),
        'LOAD_INGEST_CATALOG'
    );
    need(
        keys(value.retained, ['candidates', 'children', 'physicalChildren']) &&
            Object.values(value.retained).every(count) &&
            value.retained.candidates <= 64 &&
            value.retained.physicalChildren <= value.retained.children &&
            keys(value.accounting, [
                'activeChildren',
                'retainedChildren',
                'reservedChildren',
            ]),
        'LOAD_INGEST_CATALOG'
    );
    Object.values(value.accounting).forEach(decimal);
    need(
        value.accounting.activeChildren === String(value.currentDocuments) &&
            value.accounting.retainedChildren ===
                String(value.retained.children) &&
            keys(value.history, [
                'candidateStates',
                'cleanupPendingTasks',
                'cleanupProcessingTasks',
                'cleanupFailedTasks',
                'partialLayoutCandidates',
                'observedIndexAttempts',
                'observedAdditionalIndexAttempts',
                'observedIndexContinuations',
                'indexTasksWithErrorCode',
                'indexCancelledTasks',
                'retryHistory',
            ]) &&
            keys(value.history.candidateStates, [
                'PUBLISHED',
                'RETIRED',
                'CLEANING',
                'CLEANED',
            ]) &&
            Object.values(value.history.candidateStates).every(count) &&
            value.history.candidateStates.PUBLISHED ===
                value.currentDocuments &&
            Object.values(value.history.candidateStates).reduce(
                (a, b) => a + b,
                0
            ) ===
                value.currentDocuments + value.retained.candidates &&
            [
                'cleanupPendingTasks',
                'cleanupProcessingTasks',
                'cleanupFailedTasks',
                'partialLayoutCandidates',
                'indexTasksWithErrorCode',
                'indexCancelledTasks',
            ].every((key) => count(value.history[key])) &&
            [
                'observedIndexAttempts',
                'observedAdditionalIndexAttempts',
                'observedIndexContinuations',
            ].every(
                (key) =>
                    Number.isSafeInteger(value.history[key]) &&
                    value.history[key] >= 0 &&
                    value.history[key] <= 256000
            ) &&
            value.history.retryHistory ===
                'CURRENT_STORED_TASK_COUNTERS_NOT_LIFETIME_OR_WIRE',
        'LOAD_INGEST_CATALOG'
    );
    return value;
}

function checkedNative(value, input) {
    need(
        keys(value, [
            'organizationId',
            'collectionId',
            'producerIdentitySha256',
            'knownGapReports',
            'quiescent',
            'exclusive',
            'hours',
            'counters',
        ]) &&
            value.organizationId === input.organizationId &&
            value.collectionId === input.collectionId &&
            hash(value.producerIdentitySha256) &&
            typeof value.quiescent === 'boolean' &&
            typeof value.exclusive === 'boolean' &&
            Array.isArray(value.hours) &&
            value.hours.length <= 720 &&
            value.hours.every(
                (hour) =>
                    typeof hour === 'string' &&
                    /^\d{4}-\d\d-\d\dT\d\d:00:00\.000Z$/u.test(hour)
            ) &&
            new Set(value.hours).size === value.hours.length &&
            keys(value.counters, fields),
        'LOAD_INGEST_NATIVE'
    );
    decimal(value.knownGapReports);
    Object.values(value.counters).forEach(decimal);
    return value;
}

/** Preserve every recorded outcome; superseded/failed/retried work is not inferred from current vector rows. */
export function ingestionNativeDelta(before, after) {
    need(
        before.organizationId === after.organizationId &&
            before.collectionId === after.collectionId &&
            before.producerIdentitySha256 === after.producerIdentitySha256 &&
            hash(before.producerIdentitySha256),
        'LOAD_INGEST_PRODUCER'
    );
    need(
        before.quiescent === true &&
            after.quiescent === true &&
            before.exclusive === true &&
            after.exclusive === true,
        'LOAD_INGEST_EXCLUSIVITY'
    );
    need(
        before.hours.every((value) => after.hours.includes(value)),
        'LOAD_INGEST_HOUR_LOST'
    );
    const counters = Object.fromEntries(
        fields.map((field) => {
            const delta =
                decimal(after.counters[field]) -
                decimal(before.counters[field]);
            need(delta >= 0n, 'LOAD_INGEST_COUNTER_RESET');
            return [field, delta.toString()];
        })
    );
    const gaps =
        decimal(after.knownGapReports) - decimal(before.knownGapReports);
    need(gaps >= 0n, 'LOAD_INGEST_COUNTER_RESET');
    const started = BigInt(counters.nativeStarts),
        settled =
            BigInt(counters.nativeValidatedBatches) +
            BigInt(counters.nativeFailedBatches);
    need(settled <= started, 'LOAD_INGEST_COUNTER_RESET');
    return {
        counters,
        knownGapReports: gaps.toString(),
        knownInFlightBatches: (started - settled).toString(),
        providerInputTokens:
            BigInt(counters.unknownProviderTokenBatches) > 0n ||
            BigInt(counters.nativeValidatedBatches) === 0n ||
            BigInt(counters.nativeFailedBatches) > 0n ||
            started !== settled ||
            gaps > 0n
                ? null
                : counters.knownProviderInputTokens,
        coverage: gaps > 0n ? 'PARTIAL_KNOWN_GAP' : 'RECORDED_EXCLUSIVE_DELTA',
        billedUsageStatus: 'NOT_MEASURED',
    };
}

/** Baselines/receipts are immutable, independently scoped to phase/org/generation, and never become experiment results. */
export function createTrafficIngestionObserver({
    state,
    fixture,
    admit,
    reader,
    store,
    nowMicros,
    sleepMicros,
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
}) {
    validateIdentity(state, fixture);
    need(
        [
            admit,
            reader?.native,
            reader?.snapshot,
            store?.read,
            store?.write,
            nowMicros,
            sleepMicros,
        ].every((value) => typeof value === 'function') &&
            ['SYNTHETIC_UNIT_TEST', 'LIVE_READ_ONLY'].includes(evidenceKind),
        'LOAD_INGEST_ADAPTER'
    );
    const begun = new Set(),
        finished = new Set();
    let previousTime = 0;
    const clock = () => {
        const value = nowMicros();
        need(
            Number.isSafeInteger(value) && value >= previousTime,
            'LOAD_INGEST_CLOCK'
        );
        previousTime = value;
        return value;
    };
    const scope = (input) =>
        need(
            ['paced', 'closed-loop'].includes(input?.phase) &&
                fixture.organizationIds.includes(input.organizationId) &&
                id(input.collectionId) &&
                id(input.generationId),
            'LOAD_INGEST_SCOPE'
        );
    const stable = async (input, deadline) => {
        const value = await stableNativeSnapshot(
            async () => checkedNative(await reader.native(input), input),
            {
                now: () => Math.floor(clock() / 1000),
                sleep: async (ms) => {
                    need(
                        clock() + ms * 1000 <= deadline,
                        'LOAD_INGEST_DEADLINE'
                    );
                    await sleepMicros(ms * 1000);
                    need(clock() <= deadline, 'LOAD_INGEST_DEADLINE');
                },
                verify: async () => {
                    need(clock() <= deadline, 'LOAD_INGEST_DEADLINE');
                    await admit();
                    need(clock() <= deadline, 'LOAD_INGEST_DEADLINE');
                },
            }
        );
        need(clock() <= deadline, 'LOAD_INGEST_DEADLINE');
        return value;
    };
    return {
        async begin(input) {
            scope(input);
            const key = input.phase + '/' + input.organizationId;
            need(!begun.has(key), 'LOAD_INGEST_REPLAY');
            begun.add(key);
            const snapshot = await stable(input, clock() + 120000000);
            const baseline = {
                schemaVersion: 1,
                kind: 'INGESTION_NATIVE_BASELINE',
                evidenceKind,
                runId: state.runId,
                phase: input.phase,
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: input.generationId,
                snapshot,
            };
            const ref = digest(baseline);
            need(
                Buffer.byteLength(JSON.stringify(baseline)) <=
                    INGESTION_LIMITS.receiptBytes,
                'LOAD_INGEST_BYTES'
            );
            await store.write('ingestion-baseline-' + ref + '.json', baseline);
            return ref;
        },
        async finish(input) {
            scope(input);
            need(
                hash(input.baselineRef) && !finished.has(input.baselineRef),
                'LOAD_INGEST_REPLAY'
            );
            need(
                Number.isSafeInteger(input.deadlineMicros) &&
                    clock() < input.deadlineMicros,
                'LOAD_INGEST_DEADLINE'
            );
            const prior = input.priorBindings ?? [],
                fresh = input.newBindings ?? [];
            need(
                Array.isArray(prior) &&
                    Array.isArray(fresh) &&
                    prior.length === (input.phase === 'paced' ? 0 : 3) &&
                    fresh.length === 3 &&
                    Array.isArray(input.descriptors) &&
                    input.descriptors.length === prior.length + fresh.length,
                'LOAD_INGEST_BOUNDS'
            );
            const all = [...prior, ...fresh];
            need(
                new Set(all.map((row) => row.documentId)).size === all.length &&
                    all.every(
                        (row, index) =>
                            id(row.documentId) &&
                            id(row.versionId) &&
                            row.fixtureId ===
                                input.descriptors[index]?.fixtureId
                    ),
                'LOAD_INGEST_BINDING'
            );
            finished.add(input.baselineRef);
            const before = await store.read(
                'ingestion-baseline-' + input.baselineRef + '.json'
            );
            need(
                digest(before) === input.baselineRef &&
                    before.kind === 'INGESTION_NATIVE_BASELINE' &&
                    before.evidenceKind === evidenceKind &&
                    before.runId === state.runId &&
                    [
                        'phase',
                        'organizationId',
                        'collectionId',
                        'generationId',
                    ].every((key) => before[key] === input[key]),
                'LOAD_INGEST_BASELINE'
            );
            await admit();
            let after, native;
            do {
                after = await stable(input, input.deadlineMicros);
                native = ingestionNativeDelta(before.snapshot, after);
                if (native.knownInFlightBatches === '0') break;
                need(
                    clock() + 1000000 <= input.deadlineMicros,
                    'LOAD_INGEST_DEADLINE'
                );
                await sleepMicros(1000000);
            } while (clock() <= input.deadlineMicros);
            need(
                native.knownInFlightBatches === '0',
                'LOAD_INGEST_NATIVE_UNSETTLED'
            );
            const catalog = checkedIngestionCatalog(
                await reader.snapshot({ ...input, bindings: all })
            );
            need(clock() <= input.deadlineMicros, 'LOAD_INGEST_DEADLINE');
            const confirmed = await stable(input, input.deadlineMicros);
            need(same(after, confirmed), 'LOAD_INGEST_NOT_STABLE');
            need(
                catalog.currentDocuments === all.length &&
                    catalog.newPublishedDocuments === 3 &&
                    catalog.sourceTuplesVerified === true &&
                    catalog.canonicalLayoutVerified === true &&
                    catalog.physicalManifestsVerified === true &&
                    catalog.accountingVerified === true &&
                    catalog.noCurrentFailures === true,
                'LOAD_INGEST_CATALOG'
            );
            const receipt = {
                schemaVersion: 1,
                kind: 'INGESTION_PHASE_PROOF',
                evidenceKind,
                runId: state.runId,
                phase: input.phase,
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: input.generationId,
                ...catalog,
                native: {
                    ...native,
                    baselineSha256: input.baselineRef,
                    finalSha256: digest(confirmed),
                },
            };
            need(
                Buffer.byteLength(JSON.stringify(receipt)) <=
                    INGESTION_LIMITS.receiptBytes,
                'LOAD_INGEST_BYTES'
            );
            const sha = digest(receipt);
            await store.write('ingestion-receipt-' + sha + '.json', receipt);
            return {
                ...receipt,
                native: { ...receipt.native, receiptSha256: sha },
            };
        },
    };
}
