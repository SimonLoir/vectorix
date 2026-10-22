import { isDeepStrictEqual } from 'node:util';
import {
    MAX_DOCUMENT_SOURCES,
    type StructuredExtraction,
} from '@repo/documents';
import {
    ChunkingError,
    MAX_CHUNKS_PER_DOCUMENT,
    type ChunkSpan,
    type PlannedChunk,
} from './types';
import {
    MAX_PARENT_CONTEXT_ROWS,
    MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES,
    MAX_PARENT_CONTEXT_TEXT_BYTES,
    PARENT_CONTEXT_VERSION,
    type ParentContextLayout,
    type ParentContextOptions,
} from './parent-context-types';

function parentBudgets(options: ParentContextOptions) {
    const rows = options.maxRows ?? MAX_PARENT_CONTEXT_ROWS;
    const textBytes = options.maxTextBytes ?? MAX_PARENT_CONTEXT_TEXT_BYTES;
    const spanBytes =
        options.maxSourceSpanBytes ?? MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES;
    if (
        ![options.parentMaxTokens, rows, textBytes, spanBytes].every(
            Number.isSafeInteger
        ) ||
        options.parentMaxTokens < 32 ||
        options.parentMaxTokens > 32_768 ||
        rows < 1 ||
        rows > MAX_PARENT_CONTEXT_ROWS ||
        textBytes < 1 ||
        textBytes > MAX_PARENT_CONTEXT_TEXT_BYTES ||
        spanBytes < 1 ||
        spanBytes > MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    return {
        parentBytes: Math.min(options.parentMaxTokens * 3, 49_152),
        rows,
        textBytes,
        spanBytes,
    };
}

/** Charge incrementally before allocating derived text/provenance arrays. */
function materializationBudget(limits: ReturnType<typeof parentBudgets>) {
    let rows = 0,
        textBytes = 0,
        spanBytes = 0;
    return {
        rows(count: number) {
            rows += count;
            if (rows > limits.rows) throw new ChunkingError('CHUNK_LIMIT');
        },
        text(count: number) {
            textBytes += count;
            if (textBytes > limits.textBytes)
                throw new ChunkingError('CHUNK_LIMIT');
        },
        spans(count: number) {
            spanBytes += count;
            if (spanBytes > limits.spanBytes)
                throw new ChunkingError('CHUNK_LIMIT');
        },
    };
}
type MaterializationBudget = ReturnType<typeof materializationBudget>;

/** Validated artifacts have ordered, disjoint sources; keep that sweep invariant explicit. */
function assertArtifact(artifact: StructuredExtraction) {
    if (!artifact.sources.length)
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    if (
        artifact.text.length > 25 * 1024 ** 2 ||
        artifact.sources.length > MAX_DOCUMENT_SOURCES
    )
        throw new ChunkingError('CHUNK_LIMIT');
    let previous = 0;
    for (const [index, source] of artifact.sources.entries()) {
        if (
            source.index !== index ||
            !Number.isSafeInteger(source.start) ||
            !Number.isSafeInteger(source.end) ||
            source.start < previous ||
            source.end < source.start ||
            source.end > artifact.text.length
        )
            throw new ChunkingError('INVALID_CHUNK_PROFILE');
        previous = source.end;
    }
}

function safeOffset(text: string, offset: number) {
    return (
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset <= text.length &&
        !(
            offset > 0 &&
            offset < text.length &&
            /[\uD800-\uDBFF]/u.test(text[offset - 1]!) &&
            /[\uDC00-\uDFFF]/u.test(text[offset]!)
        )
    );
}

function nextSource(
    artifact: StructuredExtraction,
    first: number,
    start: number
) {
    while (
        first < artifact.sources.length &&
        artifact.sources[first]!.end <= start
    )
        first++;
    return first;
}

/** A monotone first-source cursor skips old sources without a full scan per row. */
function* intersectingSources(
    artifact: StructuredExtraction,
    start: number,
    end: number,
    first: number
) {
    for (let index = first; index < artifact.sources.length; index++) {
        const source = artifact.sources[index]!;
        if (source.start >= end) break;
        const from = Math.max(start, source.start),
            to = Math.min(end, source.end);
        if (from < to) yield { source, start: from, end: to };
    }
}

/** Sweep only intersecting sources and charge exact serialized span-array bytes. */
function sourceSpans(
    artifact: StructuredExtraction,
    start: number,
    end: number,
    first: number,
    budget: MaterializationBudget,
    supplied?: readonly ChunkSpan[]
) {
    if (supplied && supplied.length > MAX_DOCUMENT_SOURCES)
        throw new ChunkingError('CHUNK_LIMIT');
    const spans: ChunkSpan[] = [];
    let count = 0;
    budget.spans(2); // JSON array brackets, including empty arrays.
    for (const span of intersectingSources(artifact, start, end, first)) {
        if (supplied && !isDeepStrictEqual(supplied[count], span))
            throw new ChunkingError('INVALID_CHUNK_PROFILE');
        budget.spans(
            Buffer.byteLength(JSON.stringify(span), 'utf8') + (count ? 1 : 0)
        );
        if (!supplied) spans.push(span);
        count++;
    }
    if (!count || (supplied && supplied.length !== count))
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    return spans;
}

interface ParentRange {
    start: number;
    end: number;
    bytes: number;
}

function validatedChildBytes(
    artifact: StructuredExtraction,
    child: PlannedChunk,
    ordinal: number,
    previousStart: number,
    maximum: number
) {
    if (
        child.ordinal !== ordinal ||
        !safeOffset(artifact.text, child.start) ||
        !safeOffset(artifact.text, child.end) ||
        child.start < previousStart ||
        child.start >= child.end ||
        child.text !== artifact.text.slice(child.start, child.end)
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    const bytes = Buffer.byteLength(child.text, 'utf8');
    if (
        bytes > maximum ||
        child.tokenCount !== Math.ceil(bytes / 3) ||
        child.tokenCountIsEstimate !== true
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    return bytes;
}

function extendedParentBytes(
    text: string,
    current: ParentRange,
    end: number,
    maximum: number
) {
    // UTF-8 bytes are never fewer than UTF-16 code units. Avoid even slicing
    // a large canonical gap when this inexpensive lower bound cannot fit.
    if (end - current.start > maximum) return maximum + 1;
    return (
        current.bytes + Buffer.byteLength(text.slice(current.end, end), 'utf8')
    );
}

/**
 * Greedily group unchanged canonical children under parent-context-utf8-v1.
 * Starts are monotone, but ends may decrease or repeat in historical planners;
 * each parent therefore retains the maximum end of its children. A running byte
 * count examines only newly extended suffixes, never the whole union per child.
 *
 * All rows, duplicated UTF-8 text and serialized provenance are bounded together
 * before returning any layout. This is pure: callers first obtain a complete child
 * plan (including semantic boundary work), then finish this layout before final
 * child embedding/vector I/O. It does not enable parent mode or validate access.
 */
export function planParentContext(
    artifact: StructuredExtraction,
    children: readonly PlannedChunk[],
    options: ParentContextOptions
): ParentContextLayout {
    const limits = parentBudgets(options);
    assertArtifact(artifact);
    if (children.length > MAX_CHUNKS_PER_DOCUMENT)
        throw new ChunkingError('CHUNK_LIMIT');
    const budget = materializationBudget(limits);
    budget.rows(children.length);
    const groups: ParentRange[] = [];
    const childParentOrdinals: number[] = [];
    let current: ParentRange | undefined;
    let previousStart = 0,
        firstSource = 0;
    for (const [ordinal, child] of children.entries()) {
        const bytes = validatedChildBytes(
            artifact,
            child,
            ordinal,
            previousStart,
            limits.parentBytes
        );
        budget.text(bytes);
        firstSource = nextSource(artifact, firstSource, child.start);
        sourceSpans(
            artifact,
            child.start,
            child.end,
            firstSource,
            budget,
            child.sourceSpans
        );
        previousStart = child.start;

        const end = Math.max(current?.end ?? child.end, child.end);
        const unionBytes = current
            ? extendedParentBytes(
                  artifact.text,
                  current,
                  end,
                  limits.parentBytes
              )
            : bytes;
        if (!current || unionBytes > limits.parentBytes) {
            if (current) groups.push(current);
            budget.rows(1);
            current = { start: child.start, end: child.end, bytes };
        } else {
            current.end = end;
            current.bytes = unionBytes;
        }
        childParentOrdinals.push(children.length + groups.length);
    }
    if (current) groups.push(current);

    firstSource = 0;
    const parents = groups.map((group, index): PlannedChunk => {
        budget.text(group.bytes);
        firstSource = nextSource(artifact, firstSource, group.start);
        const spans = sourceSpans(
            artifact,
            group.start,
            group.end,
            firstSource,
            budget
        );
        return {
            ordinal: children.length + index,
            start: group.start,
            end: group.end,
            text: artifact.text.slice(group.start, group.end),
            tokenCount: Math.ceil(group.bytes / 3),
            tokenCountIsEstimate: true,
            sourceSpans: spans,
        };
    });
    return { version: PARENT_CONTEXT_VERSION, parents, childParentOrdinals };
}
