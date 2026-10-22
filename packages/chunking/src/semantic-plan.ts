import { createHash } from 'node:crypto';
import type { StructuredExtraction } from '@repo/documents';
import { cutBackward, cutForward, trimRange } from './bytes';
import {
    ChunkingError,
    MAX_CHUNKS_PER_DOCUMENT,
    type ChunkSpan,
    type PlannedChunk,
} from './types';
import {
    semanticThreshold,
    validateSemanticDistances,
} from './semantic-distance';
import { validateSemanticUnits } from './semantic-units';
import {
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
    SemanticStateError,
    type SemanticOptions,
    type SemanticRange,
    type SemanticState,
} from './semantic-types';

function planBudgets(options: SemanticOptions) {
    const {
        minTokens,
        targetTokens,
        maxTokens,
        overlapTokens,
        maxEmbeddingInputBytes,
    } = options;
    const limit = options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT;
    if (
        ![
            minTokens,
            targetTokens,
            maxTokens,
            overlapTokens,
            maxEmbeddingInputBytes,
            limit,
        ].every(Number.isSafeInteger) ||
        minTokens < 1 ||
        targetTokens < 32 ||
        minTokens > targetTokens ||
        targetTokens > maxTokens ||
        maxTokens > 16_384 ||
        overlapTokens < 0 ||
        overlapTokens >= targetTokens ||
        maxEmbeddingInputBytes < 32 ||
        maxEmbeddingInputBytes > 49_152 ||
        limit < 1 ||
        limit > MAX_CHUNKS_PER_DOCUMENT ||
        !Number.isFinite(options.semanticPercentile) ||
        options.semanticPercentile < 1 ||
        options.semanticPercentile > 99
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    const maximum = Math.min(maxTokens * 3, maxEmbeddingInputBytes);
    const target = Math.min(targetTokens * 3, maximum);
    return {
        maximum,
        target,
        minimum: Math.min(minTokens * 3, target),
        overlap: Math.min(overlapTokens * 3, target - 1),
        limit,
    };
}

function upperBound(boundaries: readonly number[], value: number) {
    let low = 0,
        high = boundaries.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (boundaries[middle]! <= value) low = middle + 1;
        else high = middle;
    }
    return low;
}

function preferredEnd(
    text: string,
    start: number,
    previousEnd: number,
    boundaries: readonly number[],
    budget: ReturnType<typeof planBudgets>
) {
    const target = cutForward(text, start, text.length, budget.target);
    if (target === text.length) return target;
    const maximum = cutForward(text, start, text.length, budget.maximum);
    const belowMinimum = cutForward(
        text,
        start,
        text.length,
        budget.minimum - 1
    );
    // Overlap must not let an already covered semantic boundary end a new window.
    const first = upperBound(boundaries, Math.max(belowMinimum, previousEnd));
    const before = upperBound(boundaries, target) - 1;
    const after = Math.max(first, before + 1);
    let end = target;
    if (before >= first) end = boundaries[before]!;
    else if (after < boundaries.length && boundaries[after]! <= maximum)
        end = boundaries[after]!;
    if (
        maximum === text.length &&
        Buffer.byteLength(text.slice(end), 'utf8') < budget.minimum
    )
        return text.length;
    return end;
}

/** Keep overlap bounded while leaving room for at least one new Unicode scalar. */
function advancingOverlapStart(
    text: string,
    start: number,
    end: number,
    budget: ReturnType<typeof planBudgets>
) {
    let next = cutBackward(text, start, end, budget.overlap);
    if (next <= start) return end;
    if (cutForward(text, next, text.length, budget.target) <= end)
        next = cutForward(text, next, end, 4);
    return next;
}

function clippedSpans(
    artifact: StructuredExtraction,
    start: number,
    end: number,
    firstSource: number
): ChunkSpan[] {
    const spans: ChunkSpan[] = [];
    for (let index = firstSource; index < artifact.sources.length; index++) {
        const source = artifact.sources[index]!;
        if (source.start >= end) break;
        const from = Math.max(start, source.start),
            to = Math.min(end, source.end);
        if (from < to) spans.push({ source, start: from, end: to });
    }
    return spans;
}

function nextSource(
    artifact: StructuredExtraction,
    start: number,
    firstSource: number
) {
    while (
        firstSource < artifact.sources.length &&
        artifact.sources[firstSource]!.end <= start
    )
        firstSource++;
    return firstSource;
}

/**
 * Plan only from complete persisted quantized distances. Positive nearest-rank ties
 * prefer the last eligible boundary before target, otherwise the first after it
 * within the hard cap, otherwise a safe target cut. Minimums are preferences and
 * useful short tails survive. Exhaust this bounded plan before any persistence/I/O.
 */
export function* chunkDocumentSemantic(
    artifact: StructuredExtraction,
    options: SemanticOptions,
    state: SemanticState
): Generator<PlannedChunk> {
    const budget = planBudgets(options);
    validateSemanticUnits(
        artifact,
        state.units,
        state.unitManifestHash,
        options
    );
    validateSemanticDistances(state.distances, state.units.length);
    const threshold = semanticThreshold(
        state.distances,
        options.semanticPercentile
    );
    const boundaries = state.distances.flatMap((score, index) =>
        threshold !== null && score > 0 && score >= threshold
            ? [state.units[index]!.end]
            : []
    );
    let start = 0,
        ordinal = 0,
        attempts = 0,
        previousEnd = 0,
        previousChunkEnd = 0,
        firstSource = 0;
    while (start < artifact.text.length) {
        if (++attempts > budget.limit) throw new ChunkingError('CHUNK_LIMIT');
        const end = preferredEnd(
            artifact.text,
            start,
            previousEnd,
            boundaries,
            budget
        );
        if (end <= previousEnd) throw new SemanticStateError();
        previousEnd = end;
        const range = trimRange(artifact.text, start, end);
        const text = artifact.text.slice(range.start, range.end);
        if (range.end > previousChunkEnd && /[\p{L}\p{N}]/u.test(text)) {
            previousChunkEnd = range.end;
            firstSource = nextSource(artifact, range.start, firstSource);
            yield {
                ordinal: ordinal++,
                ...range,
                text,
                tokenCount: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
                tokenCountIsEstimate: true,
                sourceSpans: clippedSpans(
                    artifact,
                    range.start,
                    range.end,
                    firstSource
                ),
            };
        }
        if (end === artifact.text.length) break;
        start = advancingOverlapStart(artifact.text, start, end, budget);
    }
}

function checkedRanges(ranges: readonly SemanticRange[], limit: number) {
    if (ranges.length > limit) throw new SemanticStateError();
    let previousStart = 0,
        previousEnd = 0;
    return ranges.map((range, ordinal) => {
        if (
            range.ordinal !== ordinal ||
            !Number.isSafeInteger(range.start) ||
            !Number.isSafeInteger(range.end) ||
            range.start < previousStart ||
            range.end < previousEnd ||
            range.start >= range.end ||
            range.end > 25 * 1024 ** 2
        )
            throw new SemanticStateError();
        previousStart = range.start;
        previousEnd = range.end;
        return { ordinal, start: range.start, end: range.end };
    });
}

/** Bind a final sealed range plan to the complete scores, unit manifest and execution settings. */
export function semanticPlanHash(
    state: SemanticState,
    options: SemanticOptions,
    ranges: readonly SemanticRange[]
) {
    const budget = planBudgets(options);
    validateSemanticDistances(state.distances, state.units.length);
    if (!/^[a-f\d]{64}$/u.test(state.unitManifestHash))
        throw new SemanticStateError();
    return createHash('sha256')
        .update(
            JSON.stringify({
                chunkerVersion: SEMANTIC_CHUNKER_VERSION,
                unitizerVersion: SEMANTIC_UNITIZER_VERSION,
                unitManifestHash: state.unitManifestHash,
                distances: state.distances,
                options: {
                    minTokens: options.minTokens,
                    targetTokens: options.targetTokens,
                    maxTokens: options.maxTokens,
                    overlapTokens: options.overlapTokens,
                    maxEmbeddingInputBytes: options.maxEmbeddingInputBytes,
                    maxChunks: budget.limit,
                    semanticPercentile: options.semanticPercentile,
                },
                ranges: checkedRanges(ranges, budget.limit),
            })
        )
        .digest('hex');
}

/** Verify persisted final ranges/hash once per claim before reusing a sealed deterministic plan. */
export function validateSemanticPlan(
    artifact: StructuredExtraction,
    options: SemanticOptions,
    state: SemanticState,
    ranges: readonly SemanticRange[],
    hash: string
) {
    const suppliedHash = semanticPlanHash(state, options, ranges);
    const canonical = [...chunkDocumentSemantic(artifact, options, state)].map(
        ({ ordinal, start, end }) => ({ ordinal, start, end })
    );
    if (
        !/^[a-f\d]{64}$/u.test(hash) ||
        hash !== suppliedHash ||
        semanticPlanHash(state, options, canonical) !== hash
    )
        throw new SemanticStateError();
}
