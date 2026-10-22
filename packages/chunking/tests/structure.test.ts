import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructuredExtraction } from '@repo/documents';
import { chunkDocumentStructure } from '../src/index';

const options = {
    minTokens: 8,
    targetTokens: 32,
    maxTokens: 64,
    overlapTokens: 8,
    maxEmbeddingInputBytes: 160,
};
function textArtifact(
    text: string,
    format: 'TEXT' | 'MARKDOWN' = 'TEXT'
): StructuredExtraction {
    return {
        schemaVersion: 1,
        format,
        text,
        sources: [{ kind: 'text', index: 0, start: 0, end: text.length }],
        warnings: [],
    };
}

void test('structure chunks preserve Unicode, canonical ranges and complete non-whitespace coverage', () => {
    const artifact = textArtifact(
        "L'été é 👩🏾‍💻. English source paragraph.\n\n".repeat(100)
    );
    const before = JSON.stringify(artifact);
    const chunks = [...chunkDocumentStructure(artifact, options)];
    assert.ok(chunks.length > 10);
    const covered = new Uint8Array(artifact.text.length);
    for (const [ordinal, chunk] of chunks.entries()) {
        assert.equal(chunk.ordinal, ordinal);
        assert.equal(chunk.text, artifact.text.slice(chunk.start, chunk.end));
        assert.equal(chunk.text.isWellFormed(), true);
        assert.ok(
            Buffer.byteLength(chunk.text, 'utf8') <=
                options.maxEmbeddingInputBytes
        );
        assert.equal(chunk.tokenCountIsEstimate, true);
        assert.equal(chunk.sourceSpans[0]!.start, chunk.start);
        assert.equal(chunk.sourceSpans[0]!.end, chunk.end);
        covered.fill(1, chunk.start, chunk.end);
    }
    for (let index = 0; index < artifact.text.length; index++)
        if (!/\s/u.test(artifact.text[index]!))
            assert.equal(covered[index], 1, `Missing character at ${index}`);
    assert.equal(JSON.stringify(artifact), before);
    assert.deepEqual([...chunkDocumentStructure(artifact, options)], chunks);
});

void test('PDF physical page boundaries survive empty pages and never invent a page citation', () => {
    const artifact: StructuredExtraction = {
        schemaVersion: 1,
        format: 'PDF',
        text: 'English page.\n\n\n\nPage française.',
        sources: [
            { kind: 'pdf-page', index: 0, start: 0, end: 13, page: 1 },
            { kind: 'pdf-page', index: 1, start: 15, end: 15, page: 2 },
            { kind: 'pdf-page', index: 2, start: 17, end: 32, page: 3 },
        ],
        warnings: [{ code: 'NO_TEXT', sourceIndex: 1 }],
    };
    artifact.sources[2]!.end = artifact.text.length;
    const chunks = [...chunkDocumentStructure(artifact, options)];
    assert.equal(chunks.length, 2);
    assert.deepEqual(
        chunks.map((chunk) =>
            chunk.sourceSpans.map((span) => span.source.page)
        ),
        [[1], [3]]
    );
    assert.ok(
        !chunks.some((chunk) =>
            chunk.sourceSpans.some((span) => span.source.index === 1)
        )
    );
});

void test('DOCX current headings, sections and separate stories remain distinct even below preferred minimum', () => {
    const strings = [
        'First heading',
        'Short body.',
        'Next section',
        'A footnote.',
    ];
    const text = strings.join('\n\n');
    let offset = 0;
    const artifact: StructuredExtraction = {
        schemaVersion: 1,
        format: 'DOCX',
        text,
        sources: strings.map((value, index) => {
            const start = offset;
            offset += value.length + 2;
            return {
                kind: 'docx-paragraph',
                index,
                start,
                end: start + value.length,
                paragraph: index + 1,
                part: index === 3 ? 'footnote' : 'body',
                partIndex: index === 3 ? 2 : 1,
                section: index < 2 ? 1 : index === 2 ? 2 : undefined,
                heading: index < 2 ? 'First heading' : undefined,
            };
        }),
        warnings: [],
    };
    const chunks = [
        ...chunkDocumentStructure(artifact, {
            ...options,
            minTokens: 32,
            targetTokens: 64,
            maxTokens: 128,
            maxEmbeddingInputBytes: 384,
        }),
    ];
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.text, 'First heading\n\nShort body.');
    assert.equal(chunks[0]!.sourceSpans.length, 2);
    assert.equal(chunks[1]!.sourceSpans[0]!.source.section, 2);
    assert.equal(chunks[2]!.sourceSpans[0]!.source.part, 'footnote');
});

void test('Markdown heading groups retain original text rather than rendered or prepared content', () => {
    const artifact = textArtifact(
        '# Guide\n\nBonjour équipe.\n\n## English\n\nOriginal **source**.',
        'MARKDOWN'
    );
    const chunks = [
        ...chunkDocumentStructure(artifact, {
            ...options,
            maxEmbeddingInputBytes: 192,
        }),
    ];
    assert.deepEqual(
        chunks.map((chunk) => chunk.heading),
        ['Guide', 'English']
    );
    assert.ok(chunks[1]!.text.includes('**source**'));
    assert.ok(chunks[1]!.start > 0);
});

void test('verified model byte cap wins over larger requested token sizes and overlap still advances', () => {
    const artifact = textArtifact('Interoperability'.repeat(100));
    const chunks = [
        ...chunkDocumentStructure(artifact, {
            ...options,
            targetTokens: 512,
            maxTokens: 768,
            overlapTokens: 511,
            maxEmbeddingInputBytes: 96,
        }),
    ];
    assert.ok(chunks.length > 1);
    for (const chunk of chunks)
        assert.ok(Buffer.byteLength(chunk.text, 'utf8') <= 96);
    for (let index = 1; index < chunks.length; index++)
        assert.ok(chunks[index]!.start > chunks[index - 1]!.start);
    assert.equal(chunks.at(-1)!.end, artifact.text.length);
});

void test('adversarial overlap has an explicit chunk cap rather than unbounded materialization', () => {
    assert.throws(
        () => [
            ...chunkDocumentStructure(textArtifact('x'.repeat(1000)), {
                ...options,
                maxChunks: 3,
            }),
        ],
        { code: 'CHUNK_LIMIT' }
    );
    assert.throws(
        () => [
            ...chunkDocumentStructure(textArtifact('source'), {
                ...options,
                overlapTokens: 32,
            }),
        ],
        { code: 'INVALID_CHUNK_PROFILE' }
    );
    assert.throws(
        () => [
            ...chunkDocumentStructure(textArtifact('source'), {
                ...options,
                maxEmbeddingInputBytes: 31,
            }),
        ],
        { code: 'INVALID_CHUNK_PROFILE' }
    );
});

void test('empty and punctuation-only sources do not become vector chunks', () => {
    assert.deepEqual(
        [...chunkDocumentStructure(textArtifact('\n\n... — !!!'), options)],
        []
    );
});
