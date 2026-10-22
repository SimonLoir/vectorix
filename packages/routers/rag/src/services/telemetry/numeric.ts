import {
    counterFields,
    failureClasses,
    phaseLimits,
    workloadPhases,
    type PhaseStats,
    type TelemetryDelta,
    type TelemetryPhase,
    type TelemetryTags,
} from './types';

const MAX = 9_223_372_036_854_775_807n;
const providers = new Set([
    'NONE',
    'OLLAMA',
    'COHERE',
    'VOYAGE',
    'OPENAI',
    'MISTRAL',
]);
/** Reject overflow rather than rounding observations or failing their domain operation. */
export function checked(value: bigint) {
    if (value < 0n || value > MAX)
        throw new RangeError('Invalid telemetry value.');
    return value;
}
/** Fixed approved tag space; tenant identity is the only variable dimension. */
export function validTags(tags: TelemetryTags) {
    return (
        typeof tags.organizationId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(tags.organizationId) &&
        Object.hasOwn(workloadPhases, tags.workload) &&
        providers.has(tags.provider) &&
        (tags.workload === 'EXTRACTION' ||
            tags.workload === 'SEARCH_LEXICAL') ===
            (tags.provider === 'NONE')
    );
}
/** One integer-microsecond sample with the fixed inclusive 16-bucket geometry. */
export function phaseSample(durationMicros: number): PhaseStats {
    if (!Number.isSafeInteger(durationMicros) || durationMicros < 0)
        throw new RangeError('Invalid telemetry duration.');
    const value = checked(BigInt(durationMicros));
    const index = phaseLimits.findIndex(
        (limit) => limit === null || durationMicros <= limit
    );
    return {
        samples: 1n,
        sumMicros: value,
        maxMicros: value,
        buckets: phaseLimits.map((_, slot) => (slot === index ? 1n : 0n)),
    };
}
/** Exact interval union: at most five captured internal search spans, never subtraction of embedding time. */
export function intervalUnionMicros(
    intervals: readonly (readonly [number, number])[]
) {
    if (
        intervals.length > 5 ||
        intervals.some(
            ([start, end]) =>
                !Number.isFinite(start) ||
                !Number.isFinite(end) ||
                start < 0 ||
                end < start
        )
    )
        throw new RangeError('Invalid telemetry intervals.');
    let total = 0,
        left = 0,
        right = 0;
    for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0])) {
        if (start > right) {
            total += right - left;
            left = start;
            right = end;
        } else right = Math.max(right, end);
    }
    return Math.max(0, Math.round((total + right - left) * 1000));
}
/** Functional merge means a detached flush cannot be mutated by a later observation. */
export function mergeDelta(
    tags: TelemetryTags,
    previous: TelemetryDelta,
    delta: TelemetryDelta
): TelemetryDelta {
    const merged: Record<string, unknown> = {};
    for (const field of counterFields)
        merged[field] = checked(
            (previous[field] ?? 0n) + checked(delta[field] ?? 0n)
        );
    for (const field of ['sourceReadBytes', 'artifactWrittenBytes'] as const)
        if (previous[field] !== undefined || delta[field] !== undefined)
            merged[field] = checked(
                (previous[field] ?? 0n) + checked(delta[field] ?? 0n)
            );
    const billed =
        (previous.knownBilledInputTokens ?? 0) +
        (delta.knownBilledInputTokens ?? 0);
    if (
        !Number.isFinite(billed) ||
        billed < 0 ||
        !Number.isFinite(delta.knownBilledInputTokens ?? 0) ||
        (delta.knownBilledInputTokens ?? 0) < 0
    )
        throw new RangeError('Invalid telemetry usage.');
    merged.knownBilledInputTokens = billed;
    const phases: Record<string, PhaseStats> = {};
    for (const [key, value] of Object.entries(delta.phaseStats ?? {})) {
        if (
            !(workloadPhases[tags.workload] as readonly string[]).includes(
                key
            ) ||
            value.buckets.length !== 16
        )
            throw new RangeError('Invalid telemetry phase.');
        if (
            value.buckets.reduce((a, b) => checked(a + checked(b)), 0n) !==
            checked(value.samples)
        )
            throw new RangeError('Invalid telemetry histogram.');
        const before = previous.phaseStats?.[key as TelemetryPhase];
        phases[key] = Object.freeze({
            samples: checked((before?.samples ?? 0n) + value.samples),
            sumMicros: checked(
                (before?.sumMicros ?? 0n) + checked(value.sumMicros)
            ),
            maxMicros:
                before && before.maxMicros > value.maxMicros
                    ? before.maxMicros
                    : checked(value.maxMicros),
            buckets: Object.freeze(
                value.buckets.map((count, index) =>
                    checked((before?.buckets[index] ?? 0n) + count)
                )
            ),
        });
    }
    merged.phaseStats = Object.freeze({ ...previous.phaseStats, ...phases });
    const failures = { ...previous.failureCounts };
    for (const [key, value] of Object.entries(delta.failureCounts ?? {})) {
        if (!(failureClasses as readonly string[]).includes(key))
            throw new RangeError('Invalid telemetry failure.');
        const failure = key as keyof typeof failures;
        failures[failure] = checked((failures[failure] ?? 0n) + checked(value));
    }
    merged.failureCounts = Object.freeze(failures);
    return Object.freeze(merged);
}
/** Encode exact decimal strings; absent actual-byte observations remain SQL NULL. */
export function encodeDelta(delta: TelemetryDelta) {
    return JSON.parse(
        JSON.stringify(delta, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value
        )
    ) as Record<string, unknown>;
}
