import {
    MAX_SEMANTIC_DISTANCE,
    MAX_SEMANTIC_UNITS,
    SemanticStateError,
} from './semantic-types';

/** Quantize before distance and checkpointing so a restarted float32 checkpoint replays exactly. */
export function quantizeSemanticVector(vector: readonly number[]): number[] {
    if (vector.length < 1 || vector.length > 16_000)
        throw new SemanticStateError();
    const converted: number[] = [];
    let norm = 0;
    for (const value of vector) {
        const quantized = Math.fround(value);
        if (!Number.isFinite(value) || !Number.isFinite(quantized))
            throw new SemanticStateError();
        converted.push(quantized);
        norm += quantized * quantized;
    }
    if (!Number.isFinite(norm) || norm === 0) throw new SemanticStateError();
    return converted;
}

/** Adjacent cosine distance, clamped to [0,2] and rounded to an integer at 1e-6 precision. */
export function quantizedAdjacentDistance(
    left: readonly number[],
    right: readonly number[]
) {
    if (left.length !== right.length) throw new SemanticStateError();
    const a = quantizeSemanticVector(left);
    const b = quantizeSemanticVector(right);
    let dot = 0,
        leftNorm = 0,
        rightNorm = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index]! * b[index]!;
        leftNorm += a[index]! ** 2;
        rightNorm += b[index]! ** 2;
    }
    const cosine = dot / Math.sqrt(leftNorm * rightNorm);
    if (!Number.isFinite(cosine)) throw new SemanticStateError();
    return Math.round((1 - Math.max(-1, Math.min(1, cosine))) * 1_000_000);
}

/** Validate quantized persisted scores without accepting NaN, fractions or incomplete adjacency. */
export function validateSemanticDistances(
    distances: readonly number[],
    unitCount?: number
) {
    if (
        distances.length > MAX_SEMANTIC_UNITS - 1 ||
        (unitCount !== undefined &&
            (!Number.isSafeInteger(unitCount) ||
                unitCount < 0 ||
                unitCount > MAX_SEMANTIC_UNITS ||
                distances.length !== Math.max(0, unitCount - 1))) ||
        distances.some(
            (score) =>
                !Number.isSafeInteger(score) ||
                score < 0 ||
                score > MAX_SEMANTIC_DISTANCE
        )
    )
        throw new SemanticStateError();
}

/** Nearest-rank percentile; tied scores all qualify when positive, not an exact top-percentage quota. */
export function semanticThreshold(
    distances: readonly number[],
    percentile: number
): number | null {
    validateSemanticDistances(distances);
    if (!Number.isFinite(percentile) || percentile < 1 || percentile > 99)
        throw new SemanticStateError();
    if (!distances.length) return null;
    const sorted = distances.toSorted((left, right) => left - right);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((sorted.length * percentile) / 100) - 1)
    );
    return sorted[index]!;
}
