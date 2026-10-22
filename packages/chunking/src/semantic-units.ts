import { createHash } from 'node:crypto';
import {
    MAX_DOCUMENT_SOURCES,
    type StructuredExtraction,
} from '@repo/documents';
import { cutForward, trimRange } from './bytes';
import { ChunkingError } from './types';
import {
    MAX_SEMANTIC_UNITS,
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
    SemanticStateError,
    type SemanticUnit,
    type SemanticUnitOptions,
} from './semantic-types';

function semanticUnitLimit(options: SemanticUnitOptions) {
    const limit = options.maxUnits ?? MAX_SEMANTIC_UNITS;
    if (
        !Number.isSafeInteger(options.maxEmbeddingInputBytes) ||
        options.maxEmbeddingInputBytes < 32 ||
        options.maxEmbeddingInputBytes > 49_152 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_SEMANTIC_UNITS
    )
        throw new ChunkingError('INVALID_CHUNK_PROFILE');
    return limit;
}

function assertArtifactBound(artifact: StructuredExtraction) {
    if (
        artifact.text.length > 25 * 1024 ** 2 ||
        artifact.sources.length > MAX_DOCUMENT_SOURCES
    )
        throw new ChunkingError('CHUNK_LIMIT');
}

function sentenceEnd(text: string, index: number) {
    const char = text[index]!;
    if (!'.!?。！？'.includes(char)) return;
    let end = index + 1;
    while (end < text.length && '"\'»”’)]}'.includes(text[end]!)) end++;
    if (
        '。！？'.includes(char) ||
        end === text.length ||
        /\s/u.test(text[end]!)
    )
        return end;
}

/** Fixed sentence/block scanner: no ICU segmentation, abbreviation inference or normalization. */
function* scanSegments(
    text: string
): Generator<{ start: number; end: number }> {
    let start = 0;
    let blankLine = true;
    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (char === '\n') {
            if (blankLine) {
                yield { start, end: index + 1 };
                start = index + 1;
            }
            blankLine = true;
            continue;
        }
        if (char !== ' ' && char !== '\t' && char !== '\r') blankLine = false;
        const end = sentenceEnd(text, index);
        if (end !== undefined) {
            yield { start, end };
            start = end;
            index = end - 1;
        }
    }
    if (start < text.length) yield { start, end: text.length };
}

function appendUsefulUnit(
    artifact: StructuredExtraction,
    range: { start: number; end: number },
    units: SemanticUnit[],
    limit: number
) {
    if (!/[\p{L}\p{N}]/u.test(artifact.text.slice(range.start, range.end)))
        return;
    if (units.length >= limit) throw new ChunkingError('CHUNK_LIMIT');
    units.push({ ordinal: units.length, ...range });
}

/**
 * Materialize at most 8192 useful canonical sentence/block units before provider cost.
 * Long segments split under the verified, prepared-input byte budget. Every attempted
 * segment/window counts toward a separate work cap of twice the unit limit, even
 * when it contains no letter/number; useful units never exceed the unit limit.
 * Unit ranges omit outer whitespace; intervening canonical gaps remain in final chunks.
 */
export function unitizeSemantic(
    artifact: StructuredExtraction,
    options: SemanticUnitOptions
): SemanticUnit[] {
    const limit = semanticUnitLimit(options);
    assertArtifactBound(artifact);
    const units: SemanticUnit[] = [];
    let attempts = 0;
    for (const segment of scanSegments(artifact.text)) {
        let start = segment.start;
        while (start < segment.end) {
            if (++attempts > limit * 2) throw new ChunkingError('CHUNK_LIMIT');
            const end = cutForward(
                artifact.text,
                start,
                segment.end,
                options.maxEmbeddingInputBytes
            );
            if (end <= start) throw new SemanticStateError();
            const range = trimRange(artifact.text, start, end);
            appendUsefulUnit(artifact, range, units, limit);
            start = end;
        }
    }
    return units;
}

/** A safe UTF-16 cut may separate grapheme components, but never a valid surrogate pair. */
function isSemanticOffset(text: string, offset: number) {
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

function assertUnitRanges(
    artifact: StructuredExtraction,
    units: readonly SemanticUnit[],
    options: SemanticUnitOptions
) {
    const limit = semanticUnitLimit(options);
    assertArtifactBound(artifact);
    if (units.length > limit) throw new SemanticStateError();
    let previous = 0;
    for (const [ordinal, unit] of units.entries()) {
        if (
            unit.ordinal !== ordinal ||
            !isSemanticOffset(artifact.text, unit.start) ||
            !isSemanticOffset(artifact.text, unit.end) ||
            unit.start < previous ||
            unit.start >= unit.end
        )
            throw new SemanticStateError();
        const text = artifact.text.slice(unit.start, unit.end);
        if (
            !/[\p{L}\p{N}]/u.test(text) ||
            Buffer.byteLength(text, 'utf8') > options.maxEmbeddingInputBytes
        )
            throw new SemanticStateError();
        previous = unit.end;
    }
}

/** Bind exact canonical text, fixed algorithm identities, verified byte budget and ordered unit geometry. */
export function semanticUnitManifestHash(
    artifact: StructuredExtraction,
    units: readonly SemanticUnit[],
    options: SemanticUnitOptions
) {
    assertUnitRanges(artifact, units, options);
    return createHash('sha256')
        .update(
            JSON.stringify({
                chunkerVersion: SEMANTIC_CHUNKER_VERSION,
                unitizerVersion: SEMANTIC_UNITIZER_VERSION,
                textHash: createHash('sha256')
                    .update(JSON.stringify(artifact.text), 'utf8')
                    .digest('hex'),
                maxEmbeddingInputBytes: options.maxEmbeddingInputBytes,
                units: units.map(({ ordinal, start, end }) => ({
                    ordinal,
                    start,
                    end,
                })),
            })
        )
        .digest('hex');
}

/** Replay validation is performed once per claim, before trusting a durable cursor or spending more cost. */
export function validateSemanticUnits(
    artifact: StructuredExtraction,
    units: readonly SemanticUnit[],
    hash: string,
    options: SemanticUnitOptions
) {
    const actualHash = semanticUnitManifestHash(artifact, units, options);
    if (
        !/^[a-f\d]{64}$/u.test(hash) ||
        hash !== actualHash ||
        semanticUnitManifestHash(
            artifact,
            unitizeSemantic(artifact, options),
            options
        ) !== hash
    )
        throw new SemanticStateError();
}
