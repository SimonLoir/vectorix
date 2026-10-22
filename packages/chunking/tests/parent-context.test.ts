import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_DOCUMENT_SOURCES,
    type StructuredExtraction,
} from '@repo/documents';
import {
    chunkDocumentSemantic,
    chunkDocumentStructure,
    chunkTokenWindow,
    MAX_CHUNKS_PER_DOCUMENT,
    MAX_PARENT_CONTEXT_ROWS,
    MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES,
    MAX_PARENT_CONTEXT_TEXT_BYTES,
    PARENT_CONTEXT_VERSION,
    planParentContext,
    semanticUnitManifestHash,
    unitizeSemantic,
    type ParentContextOptions,
    type PlannedChunk,
    type StructureOptions,
} from '../src/index';

const childOptions: StructureOptions = {
    minTokens: 8,
    targetTokens: 32,
    maxTokens: 64,
    overlapTokens: 8,
    maxEmbeddingInputBytes: 192,
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

function children(
    input: StructuredExtraction,
    ranges: readonly (readonly [number, number])[]
): PlannedChunk[] {
    return ranges.map(([start, end], ordinal) => {
        const text = input.text.slice(start, end);
        return {
            ordinal,
            start,
            end,
            text,
            tokenCount: Math.ceil(Buffer.byteLength(text, 'utf8') / 3),
            tokenCountIsEstimate: true,
            sourceSpans: input.sources.flatMap((source) => {
                const from = Math.max(start, source.start),
                    to = Math.min(end, source.end);
                return from < to ? [{ source, start: from, end: to }] : [];
            }),
        };
    });
}

function assertCanonical(
    input: StructuredExtraction,
    chunks: readonly PlannedChunk[],
    options: ParentContextOptions
) {
    const before = structuredClone({ input, chunks });
    const layout = planParentContext(input, chunks, options);
    assert.equal(layout.version, PARENT_CONTEXT_VERSION);
    assert.ok(layout.parents.length <= chunks.length);
    for (const [index, parent] of layout.parents.entries()) {
        assert.equal(parent.ordinal, chunks.length + index);
        assert.equal(parent.text, input.text.slice(parent.start, parent.end));
        assert.equal(parent.text.isWellFormed(), true);
        assert.equal(Object.hasOwn(parent, 'heading'), false);
        const bytes = Buffer.byteLength(parent.text, 'utf8');
        assert.ok(bytes <= Math.min(options.parentMaxTokens * 3, 49_152));
        assert.equal(parent.tokenCount, Math.ceil(bytes / 3));
        assert.equal(parent.tokenCountIsEstimate, true);
        assert.deepEqual(
            parent.sourceSpans,
            children(input, [[parent.start, parent.end]])[0]!.sourceSpans
        );
    }
    for (const child of chunks) {
        const parentOrdinal = layout.childParentOrdinals[child.ordinal]!;
        const parent = layout.parents[parentOrdinal - chunks.length]!;
        assert.ok(parent.start <= child.start);
        assert.ok(parent.end >= child.end);
    }
    assert.deepEqual({ input, chunks }, before);
    assert.deepEqual(planParentContext(input, chunks, options), layout);
    return layout;
}

void test('greedy parents retain overlapping children and the final short tail with suffix ordinals', () => {
    const input = artifact('a'.repeat(290));
    const chunks = children(input, [
        [0, 96],
        [84, 180],
        [168, 264],
        [252, 290],
    ]);
    const layout = assertCanonical(input, chunks, { parentMaxTokens: 64 });
    assert.deepEqual(
        layout.parents.map(({ start, end }) => [start, end]),
        [
            [0, 180],
            [168, 290],
        ]
    );
    assert.deepEqual(layout.childParentOrdinals, [4, 4, 5, 5]);
    assert.equal(layout.parents.at(-1)!.text.endsWith('a'.repeat(38)), true);
});

void test('historical structure-contained output and decreasing child ends retain maximum coverage', () => {
    const input = artifact(`${'a'.repeat(59)} ${'b'.repeat(300)}`);
    const legacy = [...chunkDocumentStructure(input, childOptions)];
    assert.ok(
        legacy.some(
            (child, index) =>
                index > 0 &&
                child.start > legacy[index - 1]!.start &&
                child.end <= legacy[index - 1]!.end
        ),
        'The fixture must exercise the unchanged historical contained range.'
    );
    assertCanonical(input, legacy, { parentMaxTokens: 64 });

    const contained = children(input, [
        [0, 96],
        [10, 80],
        [10, 30],
        [80, 160],
    ]);
    const layout = assertCanonical(input, contained, { parentMaxTokens: 64 });
    assert.deepEqual(
        layout.parents.map(({ start, end }) => [start, end]),
        [[0, 160]]
    );
});

void test('canonical gaps, empty sources and final-tail provenance survive without invented heading', () => {
    const input: StructuredExtraction = {
        ...artifact(`${'A'.repeat(40)}\n\n${'B'.repeat(40)}\n\nTAIL`),
        format: 'PDF',
        sources: [
            { kind: 'pdf-page', index: 0, start: 0, end: 40, page: 1 },
            { kind: 'pdf-page', index: 1, start: 41, end: 41, page: 2 },
            { kind: 'pdf-page', index: 2, start: 42, end: 82, page: 3 },
            { kind: 'pdf-page', index: 3, start: 84, end: 88, page: 4 },
        ],
    };
    const chunks = children(input, [
        [0, 25],
        [50, 70],
        [84, 88],
    ]);
    const layout = assertCanonical(input, chunks, { parentMaxTokens: 32 });
    assert.equal(layout.parents[0]!.text, input.text);
    assert.deepEqual(
        layout.parents[0]!.sourceSpans.map(({ source, start, end }) => [
            source.page,
            start,
            end,
        ]),
        [
            [1, 0, 40],
            [3, 42, 82],
            [4, 84, 88],
        ]
    );
});

void test('all unchanged child planners retain exact FR/EN, NFD and surrogate-safe geometry', () => {
    const input = artifact(
        'Français e\u0301 👩🏾‍💻. English 🇧🇪 123.\n\n'.repeat(24)
    );
    const units = unitizeSemantic(input, childOptions);
    const state = {
        units,
        distances: units.slice(1).map((_, index) => (index % 3 ? 0 : 500_000)),
        unitManifestHash: semanticUnitManifestHash(input, units, childOptions),
    };
    const plans = [
        [...chunkDocumentStructure(input, childOptions)],
        [...chunkTokenWindow(input, childOptions)],
        [
            ...chunkDocumentSemantic(
                input,
                { ...childOptions, semanticPercentile: 50 },
                state
            ),
        ],
    ];
    for (const chunks of plans) {
        assert.ok(chunks.length > 5);
        const layout = assertCanonical(input, chunks, { parentMaxTokens: 128 });
        assert.ok(
            layout.parents.some((parent) => parent.text.includes('e\u0301'))
        );
        assert.ok(layout.parents.length < chunks.length);
    }
});

void test('parent context has its independent 49152-byte ceiling and never splits a child', () => {
    const input = artifact('x'.repeat(49_153));
    const layout = assertCanonical(input, children(input, [[0, 49_152]]), {
        parentMaxTokens: 32_768,
    });
    assert.equal(layout.parents[0]!.text.length, 49_152);
    assert.throws(
        () =>
            planParentContext(input, children(input, [[0, 49_153]]), {
                parentMaxTokens: 32_768,
            }),
        { code: 'INVALID_CHUNK_PROFILE' }
    );
    const unicode = artifact('é'.repeat(49));
    assert.throws(
        () =>
            planParentContext(unicode, children(unicode, [[0, 49]]), {
                parentMaxTokens: 32,
            }),
        { code: 'INVALID_CHUNK_PROFILE' }
    );
});

void test('combined rows, duplicate text and exact serialized provenance are bounded before return', () => {
    const input = artifact('abc');
    const chunks = children(input, [[0, 3]]);
    const spanBytes = Buffer.byteLength(JSON.stringify(chunks[0]!.sourceSpans));
    const exact = {
        parentMaxTokens: 32,
        maxRows: 2,
        maxTextBytes: 6,
        maxSourceSpanBytes: spanBytes * 2,
    };
    assertCanonical(input, chunks, exact);
    for (const limits of [
        { maxRows: 1 },
        { maxTextBytes: 5 },
        { maxSourceSpanBytes: spanBytes * 2 - 1 },
    ])
        assert.throws(
            () => planParentContext(input, chunks, { ...exact, ...limits }),
            {
                code: 'CHUNK_LIMIT',
            }
        );
});

void test('the full 5000-source parent projection stays canonical and is charged incrementally', () => {
    const input = artifact('x'.repeat(MAX_DOCUMENT_SOURCES));
    input.sources = Array.from(
        { length: MAX_DOCUMENT_SOURCES },
        (_, index) => ({
            kind: 'docx-paragraph',
            index,
            start: index,
            end: index + 1,
            paragraph: index + 1,
        })
    );
    const chunks = children(input, [
        [0, 2500],
        [2500, 5000],
    ]);
    const layout = assertCanonical(input, chunks, { parentMaxTokens: 2048 });
    assert.equal(layout.parents[0]!.sourceSpans.length, MAX_DOCUMENT_SOURCES);
    assert.equal(layout.parents[0]!.sourceSpans.at(-1)!.end, 5000);
    assert.throws(
        () =>
            planParentContext(input, chunks, {
                parentMaxTokens: 2048,
                maxSourceSpanBytes: 1024,
            }),
        { code: 'CHUNK_LIMIT' }
    );
});

void test('many contained children and a large ungroupable canonical gap remain bounded work', () => {
    const input = artifact('x'.repeat(49_152));
    const ranges: [number, number][] = [[0, input.text.length]];
    for (let index = 1; index < 10_000; index++) ranges.push([0, 1]);
    const chunks = children(input, ranges);
    const layout = planParentContext(input, chunks, {
        parentMaxTokens: 32_768,
    });
    assert.equal(layout.parents.length, 1);
    assert.equal(layout.parents[0]!.end, input.text.length);
    assert.equal(layout.childParentOrdinals.at(-1), chunks.length);

    const sparse = artifact(`A${' '.repeat(2 * 1024 ** 2)}Z`);
    const sparseChunks = children(sparse, [
        [0, 1],
        [sparse.text.length - 1, sparse.text.length],
    ]);
    assert.deepEqual(
        planParentContext(sparse, sparseChunks, {
            parentMaxTokens: 32,
        }).parents.map((parent) => parent.text),
        ['A', 'Z']
    );
});

void test('invalid geometry, text, source clipping and split surrogate pairs fail without partial output', () => {
    const input = artifact('A😀BC');
    const valid = children(input, [[0, input.text.length]]);
    const invalid: PlannedChunk[][] = [
        [{ ...valid[0]!, ordinal: 1 }],
        [{ ...valid[0]!, start: -1 }],
        [{ ...valid[0]!, end: input.text.length + 1 }],
        [{ ...valid[0]!, start: 0.5 }],
        [{ ...valid[0]!, text: 'Changed' }],
        [{ ...valid[0]!, tokenCount: 0 }],
        [{ ...valid[0]!, sourceSpans: [] }],
        children(input, [[0, 2]]),
        children(input, [[2, 5]]),
        children(input, [
            [3, 5],
            [0, 1],
        ]),
    ];
    for (const chunks of invalid)
        assert.throws(
            () => planParentContext(input, chunks, { parentMaxTokens: 32 }),
            {
                code: 'INVALID_CHUNK_PROFILE',
            }
        );
});

void test('useful unattributed gaps cannot produce nonpersistable child or parent rows', () => {
    const input = artifact('AA gap BB');
    input.sources = [
        { kind: 'text', index: 0, start: 0, end: 2 },
        { kind: 'text', index: 1, start: 7, end: 9 },
    ];
    assert.throws(
        () =>
            planParentContext(input, children(input, [[3, 6]]), {
                parentMaxTokens: 32,
            }),
        { code: 'INVALID_CHUNK_PROFILE' }
    );
    input.sources = [];
    assert.throws(() => planParentContext(input, [], { parentMaxTokens: 32 }), {
        code: 'INVALID_CHUNK_PROFILE',
    });
});

void test('invalid profiles fail even for an empty plan; existing artifact and child hard bounds remain', () => {
    const input = artifact('');
    assert.deepEqual(planParentContext(input, [], { parentMaxTokens: 32 }), {
        version: PARENT_CONTEXT_VERSION,
        parents: [],
        childParentOrdinals: [],
    });
    const invalid: Partial<ParentContextOptions>[] = [
        { parentMaxTokens: 31 },
        { parentMaxTokens: 32_769 },
        { maxRows: MAX_PARENT_CONTEXT_ROWS + 1 },
        { maxTextBytes: MAX_PARENT_CONTEXT_TEXT_BYTES + 1 },
        { maxSourceSpanBytes: MAX_PARENT_CONTEXT_SOURCE_SPAN_BYTES + 1 },
    ];
    const keys: (keyof ParentContextOptions)[] = [
        'parentMaxTokens',
        'maxRows',
        'maxTextBytes',
        'maxSourceSpanBytes',
    ];
    for (const key of keys)
        for (const value of [0, 0.5, Number.NaN, Infinity])
            invalid.push({ [key]: value });
    for (const change of invalid)
        assert.throws(
            () =>
                planParentContext(input, [], {
                    parentMaxTokens: 32,
                    ...change,
                }),
            { code: 'INVALID_CHUNK_PROFILE' }
        );
    const sample = children(artifact('A'), [[0, 1]])[0]!;
    assert.throws(
        () =>
            planParentContext(
                input,
                Array.from(
                    { length: MAX_CHUNKS_PER_DOCUMENT + 1 },
                    () => sample
                ),
                {
                    parentMaxTokens: 32,
                }
            ),
        { code: 'CHUNK_LIMIT' }
    );
    input.sources = Array.from(
        { length: MAX_DOCUMENT_SOURCES + 1 },
        (_, index): StructuredExtraction['sources'][number] => ({
            kind: 'text',
            index,
            start: 0,
            end: 0,
        })
    );
    assert.throws(() => planParentContext(input, [], { parentMaxTokens: 32 }), {
        code: 'CHUNK_LIMIT',
    });
});
