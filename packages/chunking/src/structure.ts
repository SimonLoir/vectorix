import type { StructuredExtraction } from '@repo/documents';
import { cutBackward, cutForward, trimRange } from './bytes';
import { structureGroups } from './groups';
import {
    ChunkingError,
    MAX_CHUNKS_PER_DOCUMENT,
    type PlannedChunk,
    type StructureGroup,
    type StructureOptions,
} from './types';

function budgets(options: StructureOptions) {
    const {
        minTokens,
        targetTokens,
        maxTokens,
        overlapTokens,
        maxEmbeddingInputBytes,
    } = options;
    if (
        ![
            minTokens,
            targetTokens,
            maxTokens,
            overlapTokens,
            maxEmbeddingInputBytes,
            options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT,
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
        (options.maxChunks ?? 1) < 1 ||
        (options.maxChunks ?? 1) > MAX_CHUNKS_PER_DOCUMENT
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    const maximum = Math.min(maxTokens * 3, maxEmbeddingInputBytes);
    const target = Math.min(targetTokens * 3, maximum);
    return {
        maximum,
        target,
        minimum: Math.min(minTokens * 3, target),
        overlap: Math.min(overlapTokens * 3, target - 1),
    };
}
function preferredEnd(
    text: string,
    start: number,
    group: StructureGroup,
    target: number,
    minimum: number,
    maximum: number
) {
    const hard = cutForward(text, start, group.end, maximum);
    if (hard === group.end) return hard;
    const preferred = cutForward(text, start, group.end, target);
    const floor = cutForward(text, start, group.end, minimum);
    const structural = group.boundaries.findLast(
        (boundary) =>
            boundary > start && boundary >= floor && boundary <= preferred
    );
    if (structural) return structural;
    let boundary: number | undefined;
    const candidate = text.slice(start, preferred);
    for (const match of candidate.matchAll(/\n\s*\n|[.!?][\t ]+|[\t ]+/gu)) {
        const end = start + match.index + match[0].length;
        if (end >= floor) boundary = end;
    }
    return boundary ?? preferred;
}

/** Deterministic bounded structure chunks preserve exact source ranges; iteration caps adversarial overlap amplification. */
export function* chunkDocumentStructure(
    artifact: StructuredExtraction,
    options: StructureOptions
): Generator<PlannedChunk> {
    const budget = budgets(options);
    let ordinal = 0,
        firstSource = 0;
    for (const group of structureGroups(artifact)) {
        let start = group.start;
        while (start < group.end) {
            const end = preferredEnd(
                artifact.text,
                start,
                group,
                budget.target,
                budget.minimum,
                budget.maximum
            );
            if (end <= start) throw new ChunkingError('INVALID_CHUNK_PROFILE');
            const range = trimRange(artifact.text, start, end);
            if (
                range.start < range.end &&
                /[\p{L}\p{N}]/u.test(
                    artifact.text.slice(range.start, range.end)
                )
            ) {
                if (ordinal >= (options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT))
                    throw new ChunkingError('CHUNK_LIMIT');
                while (
                    firstSource < artifact.sources.length &&
                    artifact.sources[firstSource]!.end <= range.start
                )
                    firstSource++;
                const sourceSpans = [];
                for (
                    let index = firstSource;
                    index < artifact.sources.length;
                    index++
                ) {
                    const source = artifact.sources[index]!;
                    if (source.start >= range.end) break;
                    const from = Math.max(range.start, source.start),
                        to = Math.min(range.end, source.end);
                    if (from < to)
                        sourceSpans.push({ source, start: from, end: to });
                }
                yield {
                    ordinal: ordinal++,
                    ...range,
                    text: artifact.text.slice(range.start, range.end),
                    heading: group.heading,
                    tokenCount: Math.ceil(
                        Buffer.byteLength(
                            artifact.text.slice(range.start, range.end),
                            'utf8'
                        ) / 3
                    ),
                    tokenCountIsEstimate: true,
                    sourceSpans,
                };
            }
            if (end === group.end) break;
            const overlap = cutBackward(
                artifact.text,
                start,
                end,
                budget.overlap
            );
            start = overlap > start ? overlap : end;
        }
    }
}
