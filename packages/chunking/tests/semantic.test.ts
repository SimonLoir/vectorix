import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructuredExtraction } from '@repo/documents';
import {
    assertSemanticVersions,
    chunkDocumentSemantic,
    MAX_SEMANTIC_UNITS,
    quantizeSemanticVector,
    quantizedAdjacentDistance,
    resolveChunkingStrategy,
    semanticPlanHash,
    semanticThreshold,
    semanticUnitManifestHash,
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
    unitizeSemantic,
    validateSemanticPlan,
    validateSemanticUnits,
    type PlannedChunk,
    type SemanticOptions,
    type SemanticState,
} from '../src/index';

const options: SemanticOptions = {
    minTokens: 8,
    targetTokens: 32,
    maxTokens: 64,
    overlapTokens: 0,
    maxEmbeddingInputBytes: 192,
    semanticPercentile: 90,
};
function artifact(text: string): StructuredExtraction {
    return {
        schemaVersion: 1,
        format: 'TEXT',
        text,
        sources: [{ kind: 'text', index: 0, start: 0, end: text.length }],
        warnings: [],
    };
}
function stateFor(
    input: StructuredExtraction,
    profile = options,
    distances?: number[]
): SemanticState {
    const units = unitizeSemantic(input, profile);
    return {
        units,
        distances:
            distances ??
            Array.from({ length: Math.max(0, units.length - 1) }, () => 0),
        unitManifestHash: semanticUnitManifestHash(input, units, profile),
    };
}
function assertCanonical(
    input: StructuredExtraction,
    chunks: PlannedChunk[],
    profile = options
) {
    const covered = new Uint8Array(input.text.length);
    for (const [ordinal, chunk] of chunks.entries()) {
        assert.equal(chunk.ordinal, ordinal);
        assert.equal(chunk.text, input.text.slice(chunk.start, chunk.end));
        assert.equal(chunk.text.isWellFormed(), true);
        assert.equal(Object.hasOwn(chunk, 'heading'), false);
        const bytes = Buffer.byteLength(chunk.text);
        assert(
            bytes <=
                Math.min(profile.maxTokens * 3, profile.maxEmbeddingInputBytes)
        );
        assert.equal(chunk.tokenCount, Math.ceil(bytes / 3));
        assert.equal(chunk.tokenCountIsEstimate, true);
        assert.deepEqual(
            chunk.sourceSpans,
            input.sources.flatMap((source) => {
                const start = Math.max(chunk.start, source.start),
                    end = Math.min(chunk.end, source.end);
                return start < end ? [{ source, start, end }] : [];
            })
        );
        covered.fill(1, chunk.start, chunk.end);
    }
    for (let index = 0; index < input.text.length; index++)
        if (!/\s/u.test(input.text[index]!))
            assert.equal(covered[index], 1, `Missing offset ${index}`);
}

void test('fixed scanner keeps exact FR/EN, NFD, quotes and block ranges without abbreviation inference', () => {
    const input = artifact(
        '  Bonjour cafe\u0301 😀. English reply!\n\n«Dernier bloc.»\n\nFinal sans point  '
    );
    const units = unitizeSemantic(input, options);
    assert.deepEqual(
        units.map((unit) => input.text.slice(unit.start, unit.end)),
        [
            'Bonjour cafe\u0301 😀.',
            'English reply!',
            '«Dernier bloc.»',
            'Final sans point',
        ]
    );
    assert.deepEqual(
        units.map((unit) => unit.ordinal),
        [0, 1, 2, 3]
    );
    assert.deepEqual(unitizeSemantic(input, options), units);
    const cjk = artifact('第一。第二！第三？');
    assert.equal(unitizeSemantic(cjk, options).length, 3);
});

void test('long sentences split safely at the independent model input cap and retain canonical gaps', () => {
    const input = artifact(`${'Aé e\u0301 👩🏾‍💻\n'.repeat(80)}Z`);
    const profile = {
        ...options,
        maxEmbeddingInputBytes: 64,
        overlapTokens: 4,
    };
    const state = stateFor(input, profile);
    assert(state.units.length > 10);
    for (const unit of state.units) {
        const text = input.text.slice(unit.start, unit.end);
        assert(text.isWellFormed());
        assert(Buffer.byteLength(text) <= 64);
    }
    assertCanonical(
        input,
        [...chunkDocumentSemantic(input, profile, state)],
        profile
    );
});

void test('unit count is capped before cost, including exact 8192 boundary and lower operator limits', () => {
    const exact = artifact('A. '.repeat(MAX_SEMANTIC_UNITS));
    assert.equal(unitizeSemantic(exact, options).length, MAX_SEMANTIC_UNITS);
    assert.throws(() => unitizeSemantic(artifact(`${exact.text}B.`), options), {
        code: 'CHUNK_LIMIT',
    });
    assert.equal(
        unitizeSemantic(artifact('A. B.'), { ...options, maxUnits: 2 }).length,
        2
    );
    assert.throws(
        () =>
            unitizeSemantic(artifact('A. B. C.'), { ...options, maxUnits: 2 }),
        { code: 'CHUNK_LIMIT' }
    );
});

void test('empty and symbol-only units are omitted but attempted empty work is bounded independently', () => {
    for (const text of ['', ' \t\r\n ', '👩🏾‍💻 ... —'])
        assert.deepEqual(unitizeSemantic(artifact(text), options), []);
    assert.throws(
        () =>
            unitizeSemantic(artifact('. '.repeat(9)), {
                ...options,
                maxUnits: 4,
            }),
        { code: 'CHUNK_LIMIT' }
    );
    assert.throws(
        () =>
            unitizeSemantic(artifact('\n'.repeat(9)), {
                ...options,
                maxUnits: 4,
            }),
        { code: 'CHUNK_LIMIT' }
    );
});

void test('invalid unit caps reject even empty text and cannot raise the fixed hard limit', () => {
    for (const change of [
        { maxUnits: 0 },
        { maxUnits: 0.5 },
        { maxUnits: 8193 },
        { maxEmbeddingInputBytes: 31 },
        { maxEmbeddingInputBytes: 49_153 },
        { maxEmbeddingInputBytes: Number.NaN },
    ])
        assert.throws(
            () => unitizeSemantic(artifact(''), { ...options, ...change }),
            { code: 'INVALID_CHUNK_PROFILE' }
        );
});

void test('manifest replay binds exact text, byte cap and deterministic ordered unit geometry', () => {
    const input = artifact('French cafe\u0301. English source.');
    const state = stateFor(input);
    validateSemanticUnits(input, state.units, state.unitManifestHash, options);
    assert.throws(
        () =>
            validateSemanticUnits(
                artifact(input.text.normalize('NFC')),
                state.units,
                state.unitManifestHash,
                options
            ),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    assert.throws(
        () =>
            validateSemanticUnits(input, state.units, state.unitManifestHash, {
                ...options,
                maxEmbeddingInputBytes: 191,
            }),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    const forged = [{ ordinal: 0, start: 0, end: input.text.length }];
    const forgedHash = semanticUnitManifestHash(input, forged, options);
    assert.throws(
        () => validateSemanticUnits(input, forged, forgedHash, options),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    for (const units of [
        state.units.toReversed(),
        [{ ordinal: 0, start: -1, end: 4 }],
        [{ ordinal: 0, start: 1.5, end: 4 }],
    ])
        assert.throws(() => semanticUnitManifestHash(input, units, options), {
            code: 'INVALID_SEMANTIC_STATE',
        });
});

void test('explicit semantic versions are validated while the old synchronous resolver stays closed', () => {
    assertSemanticVersions(SEMANTIC_CHUNKER_VERSION, SEMANTIC_UNITIZER_VERSION);
    for (const pair of [
        ['semantic-utf8-v2', SEMANTIC_UNITIZER_VERSION],
        [SEMANTIC_CHUNKER_VERSION, 'semantic-units-utf8-v2'],
    ])
        assert.throws(() => assertSemanticVersions(pair[0]!, pair[1]!), {
            code: 'INVALID_SEMANTIC_STATE',
        });
    assert.throws(
        () => resolveChunkingStrategy('SEMANTIC', SEMANTIC_CHUNKER_VERSION),
        { code: 'INVALID_CHUNK_PROFILE' }
    );
});

void test('canonical hashes preserve raw UTF-16 distinctions rather than replacing lone surrogates', () => {
    const first = artifact('A\uD800Z');
    const second = artifact('A\uDC00Z');
    const firstUnits = unitizeSemantic(first, options);
    const secondUnits = unitizeSemantic(second, options);
    assert.notEqual(
        semanticUnitManifestHash(first, firstUnits, options),
        semanticUnitManifestHash(second, secondUnits, options)
    );
});

void test('float32 conversion precedes scoring and little-endian checkpoint restart replays identical distance', () => {
    const left = [Math.PI, 0.000_000_000_1, -0.123_456_789];
    const right = [Math.E, -0.9, 0.25];
    const converted = quantizeSemanticVector(left);
    assert.notDeepEqual(converted, left);
    const bytes = Buffer.alloc(converted.length * 4);
    for (const [index, value] of converted.entries())
        bytes.writeFloatLE(value, index * 4);
    const restarted = Array.from({ length: bytes.length / 4 }, (_, index) =>
        bytes.readFloatLE(index * 4)
    );
    assert.deepEqual(restarted, converted);
    assert.equal(
        quantizedAdjacentDistance(left, right),
        quantizedAdjacentDistance(restarted, right)
    );
    assert.deepEqual(quantizeSemanticVector(converted), converted);
});

void test('cosine scores cover identical, orthogonal and opposite vectors, including valid tiny norms', () => {
    assert.equal(quantizedAdjacentDistance([1, 0], [1, 0]), 0);
    assert.equal(quantizedAdjacentDistance([1, 0], [0, 1]), 1_000_000);
    assert.equal(quantizedAdjacentDistance([1, 0], [-1, 0]), 2_000_000);
    assert.equal(quantizedAdjacentDistance([1e-40, 0], [0, 1e-40]), 1_000_000);
    for (const vector of [
        [],
        [0, 0],
        [1e-50],
        [Number.NaN],
        [Infinity],
        [Number.MAX_VALUE],
        Array.from({ length: 16_001 }, () => 1),
    ])
        assert.throws(() => quantizeSemanticVector(vector), {
            code: 'INVALID_SEMANTIC_STATE',
        });
    assert.throws(() => quantizedAdjacentDistance([1], [1, 0]), {
        code: 'INVALID_SEMANTIC_STATE',
    });
});

void test('nearest-rank thresholds retain all positive ties rather than promising an exact top percentage', () => {
    assert.equal(semanticThreshold([], 90), null);
    assert.equal(semanticThreshold([100, 200, 200, 200, 500], 75), 200);
    assert.equal(semanticThreshold([0, 0, 0], 90), 0);
    assert.equal(semanticThreshold([9, 2, 7, 3, 6, 1, 4, 10, 5, 8], 90), 9);
    assert.equal(semanticThreshold([10, 20], 1), 10);
    assert.equal(semanticThreshold([10, 20], 99), 20);
});

void test('semantic boundaries prefer last before target, first after within max, or safe target fallback', () => {
    const input = artifact(
        Array.from({ length: 6 }, () => `${'a'.repeat(39)}.`).join(' ')
    );
    const base = stateFor(input);
    assert.equal(base.units.length, 6);
    const firstEnd = (distances: number[]) =>
        [...chunkDocumentSemantic(input, options, { ...base, distances })][0]!
            .end;
    assert.equal(firstEnd([10, 10, 10, 10, 10]), 81);
    assert.equal(firstEnd([0, 0, 10, 0, 0]), 122);
    assert.equal(firstEnd([0, 0, 0, 0, 10]), 96);
    assert.equal(firstEnd([0, 0, 0, 0, 0]), 96);
    const short = artifact(`Tiny. ${'a'.repeat(200)}`);
    const shortState = stateFor(short);
    assert.equal(
        [
            ...chunkDocumentSemantic(short, options, {
                ...shortState,
                distances: shortState.distances.map((_, index) =>
                    index === 0 ? 10 : 0
                ),
            }),
        ][0]!.end,
        96
    );
});

void test('overlap cannot reuse an isolated semantic boundary or emit a contained passage', () => {
    const input = artifact(
        Array.from({ length: 6 }, () => `${'a'.repeat(39)}.`).join(' ')
    );
    const profile = { ...options, overlapTokens: 16 };
    const state = stateFor(input, profile, [0, 10, 0, 0, 0]);
    const chunks = [...chunkDocumentSemantic(input, profile, state)];
    assert.equal(chunks[0]!.end, 81);
    assert.equal(chunks[1]!.start, 33);
    assert.equal(chunks[1]!.end, 129);
    for (let index = 1; index < chunks.length; index++)
        assert(chunks[index]!.end > chunks[index - 1]!.end);
    assertCanonical(input, chunks, profile);

    const spaced = artifact(`${'a'.repeat(81)}${' '.repeat(200)}Final.`);
    const spacedChunks = [
        ...chunkDocumentSemantic(spaced, profile, stateFor(spaced, profile)),
    ];
    for (let index = 1; index < spacedChunks.length; index++)
        assert(spacedChunks[index]!.end > spacedChunks[index - 1]!.end);
    assertCanonical(spaced, spacedChunks, profile);
});

void test('near-cap overlap makes room for the next multibyte scalar without losing its tail', () => {
    const input = artifact(`${'a'.repeat(32)}😀${'b'.repeat(35)}Z`);
    const profile = {
        ...options,
        targetTokens: 512,
        maxTokens: 768,
        overlapTokens: 511,
        maxEmbeddingInputBytes: 32,
    };
    const chunks = [
        ...chunkDocumentSemantic(input, profile, stateFor(input, profile)),
    ];
    assert.equal(chunks[0]!.end, 32);
    for (let index = 1; index < chunks.length; index++)
        assert(chunks[index]!.end > chunks[index - 1]!.end);
    assert.equal(chunks.at(-1)!.end, input.text.length);
    assertCanonical(input, chunks, profile);
});

void test('semantic tail merging respects model/max caps and never discards a useful short tail', () => {
    const input = artifact(`${'a'.repeat(96)}Z`);
    assert.equal(
        [...chunkDocumentSemantic(input, options, stateFor(input))].length,
        1
    );
    const profile = { ...options, minTokens: 32, maxEmbeddingInputBytes: 96 };
    const chunks = [
        ...chunkDocumentSemantic(input, profile, stateFor(input, profile)),
    ];
    assert.deepEqual(
        chunks.map((chunk) => chunk.text),
        ['a'.repeat(96), 'Z']
    );
    assertCanonical(input, chunks, profile);
});

void test('high overlap advances safely under a clamped model cap and work failures expose no accepted partial plan', () => {
    const input = artifact(`${'😀A'.repeat(80)}Z`);
    const profile = {
        ...options,
        targetTokens: 512,
        maxTokens: 768,
        overlapTokens: 511,
        maxEmbeddingInputBytes: 32,
    };
    const state = stateFor(input, profile);
    const chunks = [...chunkDocumentSemantic(input, profile, state)];
    assertCanonical(input, chunks, profile);
    assert.equal(chunks.at(-1)!.end, input.text.length);
    for (let index = 1; index < chunks.length; index++)
        assert(chunks[index]!.start > chunks[index - 1]!.start);
    assert.throws(
        () => [
            ...chunkDocumentSemantic(
                input,
                { ...profile, maxChunks: 2 },
                state
            ),
        ],
        { code: 'CHUNK_LIMIT' }
    );
});

void test('final work bounds count omitted windows and empty canonical text remains a valid empty plan', () => {
    const empty = artifact('');
    assert.deepEqual(
        [...chunkDocumentSemantic(empty, options, stateFor(empty))],
        []
    );
    const spaces = artifact(' '.repeat(3000));
    assert.throws(
        () => [
            ...chunkDocumentSemantic(
                spaces,
                { ...options, overlapTokens: 31, maxChunks: 2 },
                stateFor(spaces)
            ),
        ],
        { code: 'CHUNK_LIMIT' }
    );
});

void test('Markdown blocks retain original markup and source offsets without inferred heading attribution', () => {
    const input = artifact(
        '# Guide\n\nBonjour **équipe**.\n\n## English\n\nOriginal cafe\u0301 text.'
    );
    input.format = 'MARKDOWN';
    const before = JSON.stringify(input);
    const chunks = [...chunkDocumentSemantic(input, options, stateFor(input))];
    assertCanonical(input, chunks);
    assert.equal(chunks[0]!.text, input.text);
    assert.equal(JSON.stringify(input), before);
});

void test('PDF/DOCX windows cross structural sources, preserve gaps and clip spans without false headings', () => {
    for (const format of ['PDF', 'DOCX'] as const) {
        const input = artifact(`${'a'.repeat(50)}\n\n${'b'.repeat(60)}`);
        input.format = format;
        input.sources = [
            {
                kind: format === 'PDF' ? 'pdf-page' : 'docx-paragraph',
                index: 0,
                start: 0,
                end: 50,
                page: 1,
                heading: 'First',
                section: 1,
                part: 'body',
            },
            {
                kind: format === 'PDF' ? 'pdf-page' : 'docx-paragraph',
                index: 1,
                start: 52,
                end: input.text.length,
                page: 3,
                heading: 'Second',
                section: 2,
                part: 'footnote',
            },
        ];
        const chunks = [
            ...chunkDocumentSemantic(input, options, stateFor(input)),
        ];
        assertCanonical(input, chunks);
        assert.equal(chunks.length, 1);
        assert.equal(chunks[0]!.sourceSpans.length, 2);
        assert.equal(chunks[0]!.text, input.text);
    }
});

void test('semantic provenance retains all 5000 crossings internally, beyond the public projection bound', () => {
    const input = artifact('x'.repeat(5000));
    input.sources = Array.from({ length: 5000 }, (_, index) => ({
        kind: 'text',
        index,
        start: index,
        end: index + 1,
    }));
    const profile = {
        ...options,
        targetTokens: 2048,
        maxTokens: 4096,
        maxEmbeddingInputBytes: 12_288,
    };
    const chunks = [
        ...chunkDocumentSemantic(input, profile, stateFor(input, profile)),
    ];
    assert.equal(chunks[0]!.sourceSpans.length, 5000);
    assertCanonical(input, chunks, profile);
    input.sources.push({ kind: 'text', index: 5000, start: 5000, end: 5000 });
    assert.throws(() => unitizeSemantic(input, profile), {
        code: 'CHUNK_LIMIT',
    });
});

void test('invalid/incomplete persisted score arrays fail before the first yielded chunk', () => {
    const input = artifact('French. English.');
    const state = stateFor(input);
    for (const distances of [
        [],
        [0, 1],
        [-1],
        [2_000_001],
        [0.5],
        [Number.NaN],
    ])
        assert.throws(
            () =>
                chunkDocumentSemantic(input, options, {
                    ...state,
                    distances,
                }).next(),
            { code: 'INVALID_SEMANTIC_STATE' }
        );
    for (const change of [
        { overlapTokens: 32 },
        { minTokens: 0 },
        { targetTokens: 31 },
        { maxTokens: Number.MAX_SAFE_INTEGER + 1 },
        { semanticPercentile: Number.NaN },
        { semanticPercentile: 100 },
    ])
        assert.throws(
            () => [
                ...chunkDocumentSemantic(
                    input,
                    { ...options, ...change },
                    state
                ),
            ],
            { code: 'INVALID_CHUNK_PROFILE' }
        );
});

void test('sealed final plans replay identical hashes and reject altered ranges, scores, text or settings', () => {
    const input = artifact(
        'La forêt protège les renards. English sentences preserve canonical context. '.repeat(
            12
        )
    );
    const state = stateFor(input);
    const before = JSON.stringify({ input, state });
    const chunks = [...chunkDocumentSemantic(input, options, state)];
    const ranges = chunks.map(({ ordinal, start, end }) => ({
        ordinal,
        start,
        end,
    }));
    const hash = semanticPlanHash(state, options, ranges);
    validateSemanticPlan(input, options, state, ranges, hash);
    assert.deepEqual([...chunkDocumentSemantic(input, options, state)], chunks);
    assert.equal(JSON.stringify({ input, state }), before);
    assert.throws(
        () =>
            validateSemanticPlan(
                input,
                options,
                state,
                ranges.map((range, index) =>
                    index ? range : { ...range, end: range.end - 1 }
                ),
                hash
            ),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    assert.throws(
        () =>
            validateSemanticPlan(
                input,
                { ...options, semanticPercentile: 89 },
                state,
                ranges,
                hash
            ),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    assert.throws(
        () =>
            validateSemanticPlan(
                input,
                options,
                { ...state, distances: state.distances.map(() => 1) },
                ranges,
                hash
            ),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    assert.throws(
        () =>
            validateSemanticPlan(
                artifact(`X${input.text.slice(1)}`),
                options,
                state,
                ranges,
                hash
            ),
        { code: 'INVALID_SEMANTIC_STATE' }
    );
    assertCanonical(input, chunks);
});
