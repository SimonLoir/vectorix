/** Pure load-only evidence rules. Importing this module performs no I/O. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const RUNTIME_DRAFT_ONLY = true;
export const OBSERVER_LIMITS = Object.freeze({
    page: 500,
    documents: 240,
    collections: 20,
    children: 100000,
    rowsPerDocument: 1000,
    sourceBytes: 1024 * 1024,
    stableMs: 5000,
    drainMs: 120000,
    snapshotBytes: 16384,
});
export class LoadObservationError extends Error {
    constructor(code = 'LOAD_OBSERVATION_FAILED') {
        super(
            /^LOAD_OBS_[A-Z_]{1,64}$/u.test(code)
                ? code
                : 'LOAD_OBSERVATION_FAILED'
        );
        this.code = this.message;
    }
}
export const need = (value, code) => {
    if (!value) throw new LoadObservationError(code);
};
export const same = isDeepStrictEqual;
export const canonical = (value) =>
    Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : value && typeof value === 'object'
          ? '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
                .join(',') +
            '}'
          : JSON.stringify(value);
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const digest = (value) => sha(canonical(value));
export const hash = (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export const fields = Object.freeze([
    'recordedStarts',
    'recordedSuccesses',
    'recordedFailures',
    'recordedContinuations',
    'recordedSupersessions',
    'recordedDenials',
    'nativeStarts',
    'nativeValidatedBatches',
    'nativeFailedBatches',
    'validatedVectors',
    'dispatchedPreparedBytes',
    'validatedPreparedBytes',
    'validatedEstimatedInputTokens',
    'knownProviderInputTokens',
    'unknownProviderTokenBatches',
]);
export function decimal(value) {
    need(
        typeof value === 'string' &&
            /^(0|[1-9][0-9]{0,18})$/u.test(value) &&
            BigInt(value) <= 9223372036854775807n,
        'LOAD_OBS_COUNTER'
    );
    return BigInt(value);
}
export function validateIdentity(state, fixture) {
    need(
        state?.schemaVersion === 1 &&
            state.namespace === 'vectorix-m7c-load' &&
            /^[a-f0-9]{12}$/u.test(state.runId),
        'LOAD_OBS_SCOPE'
    );
    need(
        state.applicationDatabase ===
            `vectorix_m7c_load_app_${state.runId}_test` &&
            state.vectorDatabase ===
                `vectorix_m7c_load_vectors_${state.runId}_test`,
        'LOAD_OBS_DATABASE'
    );
    need(
        fixture?.namespace === state.namespace &&
            fixture.runId === state.runId &&
            fixture.organizationIds?.length === 2 &&
            new Set(fixture.organizationIds).size === 2 &&
            fixture.organizationIds.every(id),
        'LOAD_OBS_SCOPE'
    );
    for (const role of ['owner', 'reader', 'foreign'])
        need(
            fixture.users?.[role] &&
                id(fixture.users[role].userId) &&
                fixture.organizationIds.includes(
                    fixture.users[role].organizationId
                ),
            'LOAD_OBS_SCOPE'
        );
    need(
        fixture.users.owner.organizationId ===
            fixture.users.reader.organizationId &&
            fixture.users.foreign.organizationId !==
                fixture.users.owner.organizationId,
        'LOAD_OBS_SCOPE'
    );
    for (const [key, database, port] of [
        ['DATABASE_URL', state.applicationDatabase, state.ports.postgres],
        ['VECTOR_DATABASE_URL', state.vectorDatabase, state.ports.vector],
    ]) {
        let url;
        try {
            url = new URL(state.environment[key]);
        } catch {
            throw new LoadObservationError('LOAD_OBS_DATABASE');
        }
        need(
            url.protocol === 'postgresql:' &&
                url.hostname === '127.0.0.1' &&
                url.port === String(port) &&
                decodeURIComponent(url.pathname.slice(1)) === database &&
                !url.search &&
                !url.hash,
            'LOAD_OBS_DATABASE'
        );
    }
    return state.runId;
}
/** Only a native scalar delta can establish observed native rows; physical cardinality is checked separately. */
export function nativeDelta(before, after, expected) {
    need(
        before.organizationId === after.organizationId &&
            before.collectionId === after.collectionId &&
            before.producerIdentitySha256 === after.producerIdentitySha256 &&
            hash(before.producerIdentitySha256),
        'LOAD_OBS_PRODUCER'
    );
    need(
        before.quiescent === true &&
            after.quiescent === true &&
            before.exclusive === true &&
            after.exclusive === true,
        'LOAD_OBS_EXCLUSIVITY'
    );
    need(
        decimal(before.knownGapReports) === decimal(after.knownGapReports),
        'LOAD_OBS_GAP'
    );
    need(
        Array.isArray(before.hours) &&
            Array.isArray(after.hours) &&
            before.hours.every((hour) => after.hours.includes(hour)),
        'LOAD_OBS_HOUR_LOST'
    );
    const delta = Object.fromEntries(
        fields.map((field) => {
            const a = decimal(before.counters[field]),
                b = decimal(after.counters[field]);
            need(b >= a, 'LOAD_OBS_COUNTER_RESET');
            return [field, b - a];
        })
    );
    need(
        Number.isSafeInteger(expected.children) &&
            expected.children >= 0 &&
            expected.children <= OBSERVER_LIMITS.children &&
            Number.isSafeInteger(expected.documents) &&
            expected.documents >= 0 &&
            expected.documents <= 200,
        'LOAD_OBS_BOUNDS'
    );
    need(
        delta.validatedVectors === BigInt(expected.children) &&
            delta.recordedStarts === BigInt(expected.documents) &&
            delta.recordedSuccesses === BigInt(expected.documents),
        'LOAD_OBS_NATIVE_COVERAGE'
    );
    need(
        [
            'recordedFailures',
            'recordedContinuations',
            'recordedSupersessions',
            'recordedDenials',
            'nativeFailedBatches',
        ].every((field) => delta[field] === 0n),
        'LOAD_OBS_NATIVE_FAILURE'
    );
    const batches = delta.nativeValidatedBatches;
    need(
        delta.nativeStarts === batches &&
            batches >= (expected.children ? 1n : 0n) &&
            batches <= BigInt(expected.children) &&
            delta.unknownProviderTokenBatches <= batches &&
            delta.dispatchedPreparedBytes === delta.validatedPreparedBytes,
        'LOAD_OBS_NATIVE_COVERAGE'
    );
    need(
        delta.validatedPreparedBytes === BigInt(expected.preparedBytes) &&
            delta.validatedEstimatedInputTokens ===
                BigInt(expected.estimatedInputTokens),
        'LOAD_OBS_NATIVE_INPUT'
    );
    return {
        validatedNativeVectors: Number(delta.validatedVectors),
        retries: 0,
        errors: 0,
        providerInputTokens:
            batches === 0n || delta.unknownProviderTokenBatches > 0n
                ? null
                : delta.knownProviderInputTokens.toString(),
        nativeWorkProof: {
            kind: 'EXCLUSIVE_INDEXING_DELTA',
            baselineSha256: digest(before),
            producerIdentitySha256: before.producerIdentitySha256,
            finalSha256: digest(after),
            stableFinal: true,
            exclusive: true,
            knownGapReports: '0',
            nativeBatches: Number(batches),
            nativeStartedBatches: Number(delta.nativeStarts),
            nativeFinishedBatches: Number(batches),
            nativeBatchErrors: 0,
        },
    };
}
/** Millisecond sampling stability is a prerequisite, never a recorder flush acknowledgement. */
export async function stableNativeSnapshot(
    read,
    { now, sleep, verify, expected = null }
) {
    const started = now();
    let previous = null,
        unchangedSince = null;
    while (now() - started <= OBSERVER_LIMITS.drainMs) {
        await verify();
        const value = await read();
        need(
            Buffer.byteLength(canonical(value)) <=
                OBSERVER_LIMITS.snapshotBytes,
            'LOAD_OBS_BOUNDS'
        );
        fields.forEach((field) => decimal(value.counters[field]));
        decimal(value.knownGapReports);
        if (
            value.quiescent &&
            value.exclusive &&
            previous &&
            same(previous, value)
        ) {
            unchangedSince ??= now();
            if (now() - unchangedSince >= OBSERVER_LIMITS.stableMs) {
                if (expected) nativeDelta(expected.before, value, expected);
                return value;
            }
        } else unchangedSince = null;
        previous = value;
        await sleep(1000);
    }
    throw new LoadObservationError('LOAD_OBS_NOT_DRAINED');
}
