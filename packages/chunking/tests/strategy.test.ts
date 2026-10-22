import assert from 'node:assert/strict';
import test from 'node:test';
import type { StructuredExtraction } from '@repo/documents';
import {
    chunkDocumentStructure,
    chunkTokenWindow,
    resolveChunkingStrategy,
    STRUCTURE_CHUNKER_VERSION,
    TOKEN_WINDOW_CHUNKER_VERSION,
} from '../src/index';

void test('admission resolves exact current versions and saved pairs select the unchanged planner', () => {
    for (const [strategy, version, plan] of [
        [
            'DOCUMENT_STRUCTURE',
            STRUCTURE_CHUNKER_VERSION,
            chunkDocumentStructure,
        ],
        ['TOKEN_WINDOW', TOKEN_WINDOW_CHUNKER_VERSION, chunkTokenWindow],
    ] as const) {
        assert.equal(resolveChunkingStrategy(strategy).version, version);
        assert.equal(resolveChunkingStrategy(strategy, version).plan, plan);
    }
});

void test('unknown strategies and saved version mismatches reject synchronously without content', () => {
    for (const [strategy, version] of [
        ['', undefined],
        ['PARAGRAPH', undefined],
        ['token_window', undefined],
        ['DOCUMENT_STRUCTURE', TOKEN_WINDOW_CHUNKER_VERSION],
        ['TOKEN_WINDOW', STRUCTURE_CHUNKER_VERSION],
        ['DOCUMENT_STRUCTURE', 'structure-utf8-v2'],
        ['TOKEN_WINDOW', 'token-window-utf8-v2'],
        ['TOKEN_WINDOW', ''],
    ] as const)
        assert.throws(() => resolveChunkingStrategy(strategy, version), {
            code: 'INVALID_CHUNK_PROFILE',
        });
});

void test('saved structure-utf8-v1 replay retains heading groups instead of token windows', () => {
    const text = '# French\n\nBonjour.\n\n## English\n\nOriginal **source**.';
    const input: StructuredExtraction = {
        schemaVersion: 1,
        format: 'MARKDOWN',
        text,
        sources: [{ kind: 'text', index: 0, start: 0, end: text.length }],
        warnings: [],
    };
    const options = {
        minTokens: 8,
        targetTokens: 32,
        maxTokens: 64,
        overlapTokens: 8,
        maxEmbeddingInputBytes: 192,
    };
    const saved = resolveChunkingStrategy(
        'DOCUMENT_STRUCTURE',
        'structure-utf8-v1'
    );
    const chunks = [...saved.plan(input, options)];
    assert.deepEqual(chunks, [...chunkDocumentStructure(input, options)]);
    assert.equal(chunks.length, 2);
    assert.deepEqual(
        chunks.map((chunk) => chunk.heading),
        ['French', 'English']
    );
    assert.equal(
        [...resolveChunkingStrategy('TOKEN_WINDOW').plan(input, options)]
            .length,
        1
    );
});
