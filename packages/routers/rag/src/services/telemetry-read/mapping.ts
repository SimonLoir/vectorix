import {
    telemetryCounter,
    telemetryCounters,
    telemetryPhaseSummary,
} from '@repo/api-contracts/v1/rag/telemetry';
import { phaseLimits } from '../telemetry/types';
import { summedFields, type AggregateRow, type PhaseRow } from './queries';

/** Reject overflow instead of rounding or silently truncating a recorded subtotal. */
function exact(value: string | null | undefined) {
    return telemetryCounter.parse(value ?? '0');
}

export function mapCounters(row: AggregateRow) {
    const batches = BigInt(exact(row.nativeValidatedBatches));
    const unknownProvider = BigInt(exact(row.unknownProviderTokenBatches));
    const unknownBilled = BigInt(exact(row.unknownBilledTokenBatches));
    if (unknownProvider > batches || unknownBilled > batches)
        throw new Error('Invalid recorded usage denominator.');
    return telemetryCounters.parse({
        ...Object.fromEntries(
            summedFields.map((field) => [field, exact(row[field])])
        ),
        validatedVectors: batches ? exact(row.validatedVectors) : null,
        validatedEstimatedInputTokens: batches
            ? exact(row.validatedEstimatedInputTokens)
            : null,
        knownProviderInputTokens:
            batches > unknownProvider
                ? exact(row.knownProviderInputTokens)
                : null,
        knownBilledInputTokens:
            batches > unknownBilled ? row.knownBilledInputTokens : null,
        sourceReadBytes:
            row.sourceReadBytes === null ? null : exact(row.sourceReadBytes),
        artifactWrittenBytes:
            row.artifactWrittenBytes === null
                ? null
                : exact(row.artifactWrittenBytes),
    });
}

/** NULL I/O remains unknown until at least one actual successful byte observation. */
export function sumCounters(rows: AggregateRow[]): AggregateRow {
    const result = Object.fromEntries(
        summedFields.map((field) => [
            field,
            field === 'sourceReadBytes' || field === 'artifactWrittenBytes'
                ? null
                : '0',
        ])
    ) as Record<(typeof summedFields)[number], string | null>;
    let knownBilledInputTokens = 0;
    for (const row of rows) {
        for (const field of summedFields) {
            if (row[field] !== null)
                result[field] = (
                    BigInt(result[field] ?? '0') + BigInt(exact(row[field]))
                ).toString();
        }
        knownBilledInputTokens += row.knownBilledInputTokens;
    }
    return { ...result, knownBilledInputTokens };
}

/** Quantiles are fixed-histogram intervals, never precise measured percentiles. */
export function mapPhase(row: PhaseRow) {
    const samples = BigInt(exact(row.samples));
    if (!samples) return null;
    if (row.buckets.length !== phaseLimits.length)
        throw new Error('Invalid recorded phase buckets.');
    const bins = row.buckets.map((value) => BigInt(exact(value)));
    if (bins.reduce((a, b) => a + b, 0n) !== samples)
        throw new Error('Invalid recorded sample count.');
    const quantile = (percent: bigint) => {
        const rank = (samples * percent + 99n) / 100n;
        let accumulated = 0n;
        for (let index = 0; index < bins.length; index++) {
            accumulated += bins[index]!;
            if (accumulated >= rank)
                return {
                    lowerMicros:
                        index === 0 ? '0' : String(phaseLimits[index - 1]! + 1),
                    upperMicros:
                        phaseLimits[index] === null
                            ? null
                            : String(phaseLimits[index]),
                };
        }
        throw new Error('Invalid recorded quantile.');
    };
    return telemetryPhaseSummary.parse({
        name: row.phase,
        samples: exact(row.samples),
        totalMicros: exact(row.sumMicros),
        maxMicros: exact(row.maxMicros),
        meanMicros: (BigInt(exact(row.sumMicros)) / samples).toString(),
        p50: quantile(50n),
        p95: quantile(95n),
    });
}
