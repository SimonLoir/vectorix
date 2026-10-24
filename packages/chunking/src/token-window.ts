import {
    MAX_DOCUMENT_SOURCES,
    type StructuredExtraction,
} from '@repo/documents';
import { cutBackward, cutForward, trimRange } from './bytes';
import {
    ChunkingError,
    MAX_CHUNKS_PER_DOCUMENT,
    type ChunkSpan,
    type PlannedChunk,
    type StructureOptions,
} from './types';

function windowBudgets(options: StructureOptions) {
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
        maxTokens < 32 ||
        minTokens > targetTokens ||
        targetTokens > maxTokens ||
        maxTokens > 16_384 ||
        overlapTokens < 0 ||
        overlapTokens >= targetTokens ||
        maxEmbeddingInputBytes < 32 ||
        maxEmbeddingInputBytes > 49_152 ||
        limit < 1 ||
        limit > MAX_CHUNKS_PER_DOCUMENT
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    const maximum = Math.min(maxTokens * 3, maxEmbeddingInputBytes);
    const target = Math.min(targetTokens * 3, maximum);
    return {
        maximum,
        target,
        minimum: minTokens * 3,
        overlap: Math.min(overlapTokens * 3, target - 1),
        limit,
    };
}

/** Coalesce only a short final suffix that still fits the maximum/model byte budget. */
function windowEnd(
    text: string,
    start: number,
    budget: ReturnType<typeof windowBudgets>
) {
    const end = cutForward(text, start, text.length, budget.target);
    return end < text.length &&
        cutForward(text, start, text.length, budget.maximum) === text.length &&
        Buffer.byteLength(text.slice(end), 'utf8') < budget.minimum
        ? text.length
        : end;
}

/** Clip every intersecting source; never promote one source's heading to the whole window. */
function clipSources(
    artifact: StructuredExtraction,
    start: number,
    end: number,
    firstSource: number
): ChunkSpan[] {
    const spans: ChunkSpan[] = [];
    for (let index = firstSource; index < artifact.sources.length; index++) {
        const source = artifact.sources[index]!;
        if (source.start >= end) break;
        const from = Math.max(start, source.start);
        const to = Math.min(end, source.end);
        if (from < to) spans.push({ source, start: from, end: to });
    }
    return spans;
}

function firstIntersectingSource(
    artifact: StructuredExtraction,
    firstSource: number,
    start: number
) {
    while (
        firstSource < artifact.sources.length &&
        artifact.sources[firstSource]!.end <= start
    )
        firstSource++;
    return firstSource;
}

/**
 * Plan canonical windows using estimated tokens (UTF-8 bytes / 3), not a model tokenizer.
 * Windows may cross structural boundaries. Safe UTF-16 cuts preserve surrogate pairs;
 * text is neither normalized nor made grapheme-safe. Every attempted window counts
 * toward maxChunks, including omitted whitespace/punctuation/emoji-only windows.
 * Callers must exhaust the plan before persistence or provider I/O: later limits throw.
 */
export function* chunkTokenWindow(
    artifact: StructuredExtraction,
    options: StructureOptions
): Generator<PlannedChunk> {
    const budget = windowBudgets(options);
    if (artifact.sources.length > MAX_DOCUMENT_SOURCES)
        throw new ChunkingError('CHUNK_LIMIT');
    let start = 0,
        ordinal = 0,
        attempts = 0,
        firstSource = 0;
    while (start < artifact.text.length) {
        if (++attempts > budget.limit) throw new ChunkingError('CHUNK_LIMIT');
        const end = windowEnd(artifact.text, start, budget);
        if (end <= start) throw new ChunkingError('INVALID_CHUNK_PROFILE');
        const range = trimRange(artifact.text, start, end);
        const text = artifact.text.slice(range.start, range.end);
        if (/[\p{L}\p{N}]/u.test(text)) {
            firstSource = firstIntersectingSource(
                artifact,
                firstSource,
                range.start
            );
            yield {
                ordinal: ordinal++,
                ...range,
                text,
                tokenCount: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
                tokenCountIsEstimate: true,
                sourceSpans: clipSources(
                    artifact,
                    range.start,
                    range.end,
                    firstSource
                ),
            };
        }
        if (end === artifact.text.length) break;
        const overlap = cutBackward(artifact.text, start, end, budget.overlap);
        start = overlap > start ? overlap : end;
    }
}
