import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MAX_DOCUMENT_SOURCES,
    type StructuredExtraction,
} from '@repo/documents';
import {
    chunkTokenWindow,
    MAX_CHUNKS_PER_DOCUMENT,
    type PlannedChunk,
    type StructureOptions,
} from '../src/index';

const options: StructureOptions = {
    minTokens: 8,
    targetTokens: 32,
    maxTokens: 64,
    overlapTokens: 0,
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

function assertCanonicalPlan(
    input: StructuredExtraction,
    chunks: PlannedChunk[],
    profile: StructureOptions
) {
    for (const [ordinal, chunk] of chunks.entries()) {
        assert.equal(chunk.ordinal, ordinal);
        assert.ok(chunk.start < chunk.end);
        assert.equal(chunk.text, input.text.slice(chunk.start, chunk.end));
        assert.equal(chunk.text.isWellFormed(), true);
        const bytes = Buffer.byteLength(chunk.text, 'utf8');
        assert.ok(
            bytes <=
                Math.min(profile.maxTokens * 3, profile.maxEmbeddingInputBytes)
        );
        assert.equal(chunk.tokenCount, Math.ceil(bytes / 3));
        assert.equal(chunk.tokenCountIsEstimate, true);
        assert.equal(Object.hasOwn(chunk, 'heading'), false);
        if (ordinal > 0) {
            assert.ok(chunk.start >= chunks[ordinal - 1]!.start);
            assert.ok(chunk.end >= chunks[ordinal - 1]!.end);
        }
        assert.deepEqual(
            chunk.sourceSpans,
            input.sources.flatMap((source) => {
                const start = Math.max(source.start, chunk.start);
                const end = Math.min(source.end, chunk.end);
                return start < end ? [{ source, start, end }] : [];
            })
        );
    }
}

function assertCovered(text: string, chunks: PlannedChunk[]) {
    const covered = new Uint8Array(text.length);
    for (const chunk of chunks) covered.fill(1, chunk.start, chunk.end);
    for (let index = 0; index < text.length; index++)
        if (!/\s/u.test(text[index]!))
            assert.equal(
                covered[index],
                1,
                `Missing original text at ${index}`
            );
}

void test('token windows retain exact FR/EN, NFD and emoji text with deterministic canonical ranges', () => {
    const input = artifact(
        "L'été e\u0301 👩🏾‍💻. English 🇧🇪 source 123.\n\n".repeat(80)
    );
    const before = JSON.stringify(input);
    const profile = {
        ...options,
        overlapTokens: 8,
        maxEmbeddingInputBytes: 104,
    };
    const chunks = [...chunkTokenWindow(input, profile)];
    assert.ok(chunks.length > 20);
    assertCanonicalPlan(input, chunks, profile);
    assertCovered(input.text, chunks);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual([...chunkTokenWindow(input, profile)], chunks);
    assert.ok(chunks.some((chunk) => chunk.text.includes('e\u0301')));
});

void test('zero overlap makes fixed byte windows independent of punctuation, paragraphs and headings', () => {
    const input = artifact('a'.repeat(240));
    const chunks = [...chunkTokenWindow(input, options)];
    assert.deepEqual(
        chunks.map((chunk) => [chunk.start, chunk.end]),
        [
            [0, 96],
            [96, 192],
            [192, 240],
        ]
    );
    assertCanonicalPlan(input, chunks, options);
    assertCovered(input.text, chunks);
});

void test('minimum only coalesces a short final suffix when maximum and model budgets allow it', () => {
    const input = artifact('a'.repeat(105));
    assert.deepEqual(
        [...chunkTokenWindow(input, options)].map((chunk) => chunk.text.length),
        [105]
    );
    for (const profile of [
        { ...options, minTokens: 1 },
        { ...options, maxTokens: 32 },
        { ...options, maxEmbeddingInputBytes: 104 },
    ]) {
        const chunks = [...chunkTokenWindow(input, profile)];
        assert.deepEqual(
            chunks.map((chunk) => chunk.text.length),
            [96, 9]
        );
        assertCanonicalPlan(input, chunks, profile);
        assertCovered(input.text, chunks);
    }
    const exactMinimum = artifact('a'.repeat(120));
    assert.deepEqual(
        [...chunkTokenWindow(exactMinimum, options)].map(
            (chunk) => chunk.text.length
        ),
        [96, 24]
    );
});

void test('a useful one-character tail survives even when it cannot meet minimum size', () => {
    const input = artifact(`${'a'.repeat(96)}Z`);
    const profile = { ...options, minTokens: 32, maxEmbeddingInputBytes: 96 };
    const chunks = [...chunkTokenWindow(input, profile)];
    assert.deepEqual(
        chunks.map((chunk) => chunk.text),
        ['a'.repeat(96), 'Z']
    );
    assertCovered(input.text, chunks);
});

void test('verified context cap clamps target and overlap while safe Unicode windows advance', () => {
    const input = artifact('😀A'.repeat(80));
    const profile = {
        ...options,
        targetTokens: 512,
        maxTokens: 768,
        overlapTokens: 511,
        maxEmbeddingInputBytes: 32,
    };
    const chunks = [...chunkTokenWindow(input, profile)];
    assert.ok(chunks.length > 10);
    assertCanonicalPlan(input, chunks, profile);
    assertCovered(input.text, chunks);
    assert.equal(chunks.at(-1)!.end, input.text.length);
    for (let index = 1; index < chunks.length; index++)
        assert.ok(chunks[index]!.start > chunks[index - 1]!.start);
});

void test('Unicode boundary combinations preserve code points without normalizing combining marks', () => {
    const atoms = ['A', 'é', 'e\u0301', '😀', '👩🏾‍💻', '🇧🇪', '中', '\n', ' '];
    for (let seed = 1; seed <= 32; seed++) {
        let state = seed;
        let text = '';
        for (let index = 0; index < 160; index++) {
            state = (state * 1_664_525 + 1_013_904_223) >>> 0;
            text += `A${atoms[state % atoms.length]!}`;
        }
        // Keep the final window useful too: symbol-only tails are intentionally omitted.
        text += 'Z';
        const input = artifact(text);
        const profile = {
            ...options,
            overlapTokens: seed % 32,
            maxEmbeddingInputBytes: 32 + seed,
        };
        const chunks = [...chunkTokenWindow(input, profile)];
        assertCanonicalPlan(input, chunks, profile);
        assertCovered(text, chunks);
    }
});

void test('windows cross PDF pages with exact clipped citations and no empty-page attribution', () => {
    const input: StructuredExtraction = {
        schemaVersion: 1,
        format: 'PDF',
        text: `${'p'.repeat(60)}\n\n${'q'.repeat(60)}`,
        sources: [
            { kind: 'pdf-page', index: 0, start: 0, end: 60, page: 1 },
            { kind: 'pdf-page', index: 1, start: 61, end: 61, page: 2 },
            { kind: 'pdf-page', index: 2, start: 62, end: 122, page: 3 },
        ],
        warnings: [{ code: 'NO_TEXT', sourceIndex: 1 }],
    };
    const chunks = [...chunkTokenWindow(input, options)];
    assertCanonicalPlan(input, chunks, options);
    assert.deepEqual(
        chunks[0]!.sourceSpans.map((span) => [
            span.source.page,
            span.start,
            span.end,
        ]),
        [
            [1, 0, 60],
            [3, 62, 96],
        ]
    );
    assert.deepEqual(
        chunks[1]!.sourceSpans.map((span) => [
            span.source.page,
            span.start,
            span.end,
        ]),
        [[3, 96, 122]]
    );
});

void test('DOCX sections and story parts can share a window with their own source metadata', () => {
    const input: StructuredExtraction = {
        schemaVersion: 1,
        format: 'DOCX',
        text: 'First heading\n\nBody text.\n\nFootnote.',
        sources: [
            {
                kind: 'docx-paragraph',
                index: 0,
                start: 0,
                end: 13,
                paragraph: 1,
                section: 1,
                heading: 'First heading',
                part: 'body',
                partIndex: 1,
            },
            {
                kind: 'docx-paragraph',
                index: 1,
                start: 15,
                end: 25,
                paragraph: 2,
                section: 2,
                heading: 'Other section',
                part: 'body',
                partIndex: 1,
            },
            {
                kind: 'docx-paragraph',
                index: 2,
                start: 27,
                end: 36,
                paragraph: 3,
                part: 'footnote',
                partIndex: 2,
            },
        ],
        warnings: [],
    };
    input.sources[2]!.end = input.text.length;
    const chunks = [...chunkTokenWindow(input, options)];
    assert.equal(chunks.length, 1);
    assertCanonicalPlan(input, chunks, options);
    assert.deepEqual(
        chunks[0]!.sourceSpans.map((span) => span.source.heading),
        ['First heading', 'Other section', undefined]
    );
    assert.equal(chunks[0]!.sourceSpans[2]!.source.part, 'footnote');
});

void test('Markdown headings are not structural boundaries or whole-window heading attribution', () => {
    const input = artifact(
        '# French\n\nBonjour.\n\n## English\n\nOriginal **text**.'
    );
    input.format = 'MARKDOWN';
    const chunks = [...chunkTokenWindow(input, options)];
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.text, input.text);
    assertCanonicalPlan(input, chunks, options);
});

void test('more than 64 crossings retain all spans and the artifact source bound is enforced', () => {
    const input = artifact('x'.repeat(MAX_DOCUMENT_SOURCES));
    input.format = 'DOCX';
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
    const profile = {
        ...options,
        targetTokens: 2048,
        maxTokens: 4096,
        maxEmbeddingInputBytes: 12_288,
    };
    const chunks = [...chunkTokenWindow(input, profile)];
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.sourceSpans.length, MAX_DOCUMENT_SOURCES);
    assertCanonicalPlan(input, chunks, profile);
    input.sources.push({
        kind: 'text',
        index: MAX_DOCUMENT_SOURCES,
        start: input.text.length,
        end: input.text.length,
    });
    assert.throws(() => [...chunkTokenWindow(input, profile)], {
        code: 'CHUNK_LIMIT',
    });
});

void test('empty and symbol-only inputs are omitted but symbols in useful windows remain', () => {
    for (const text of ['', '\n\t  ', '... — !!!', '👩🏾‍💻 😀'])
        assert.deepEqual([...chunkTokenWindow(artifact(text), options)], []);
    const input = artifact('  ... 😀 A — !!!  ');
    const chunks = [...chunkTokenWindow(input, options)];
    assert.equal(chunks[0]!.text, '... 😀 A — !!!');
    assertCanonicalPlan(input, chunks, options);
});

void test('attempt limits bound omitted whitespace/punctuation windows even with high overlap', () => {
    for (const text of [' '.repeat(2000), '.'.repeat(2000)])
        assert.throws(
            () => [
                ...chunkTokenWindow(artifact(text), {
                    ...options,
                    overlapTokens: 31,
                    maxChunks: 5,
                }),
            ],
            { code: 'CHUNK_LIMIT' }
        );
    const profile = { ...options, maxTokens: 32, maxChunks: 3 };
    assert.equal(
        [...chunkTokenWindow(artifact('x'.repeat(288)), profile)].length,
        3
    );
    assert.throws(
        () => [...chunkTokenWindow(artifact('x'.repeat(289)), profile)],
        { code: 'CHUNK_LIMIT' }
    );
});

void test('invalid numeric profiles fail for empty input without clamping unsafe values', () => {
    const invalid: Partial<StructureOptions>[] = [
        { minTokens: 0 },
        { minTokens: 33 },
        { targetTokens: 31 },
        { targetTokens: 65 },
        { maxTokens: 31 },
        { maxTokens: 16_385 },
        { overlapTokens: -1 },
        { overlapTokens: 32 },
        { maxEmbeddingInputBytes: 31 },
        { maxEmbeddingInputBytes: 49_153 },
        { maxChunks: 0 },
        { maxChunks: MAX_CHUNKS_PER_DOCUMENT + 1 },
    ];
    for (const key of Object.keys(options) as (keyof StructureOptions)[])
        for (const value of [
            0.5,
            Number.NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
        ])
            invalid.push({ [key]: value });
    for (const change of invalid)
        assert.throws(
            () => [
                ...chunkTokenWindow(artifact(''), { ...options, ...change }),
            ],
            { code: 'INVALID_CHUNK_PROFILE' }
        );
});
