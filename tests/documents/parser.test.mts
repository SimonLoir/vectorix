import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
    parseRichDocument,
    DocumentParserError,
    DOCX_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    LIMITS,
} from '../../apps/workers/src/extraction/main';
import { runPoppler } from '../../apps/workers/src/extraction/subprocess';
import {
    validateExtraction,
    type StructuredExtraction,
} from '../../apps/workers/src/extraction/limits';

const fixtures = new URL('./fixtures/', import.meta.url);
const expected = JSON.parse(
    await readFile(new URL('expected.json', fixtures), 'utf8')
) as Record<
    string,
    {
        pages?: string[];
        noTextPages?: number[];
        noTextSourceIndices?: number[];
        expectedError?: string;
        paragraphs?: Array<{
            paragraph: number;
            section?: number;
            part?: 'body' | 'header' | 'footer' | 'footnote' | 'endnote';
            partIndex?: number;
            heading?: string;
            text: string;
        }>;
        excludedText?: string[];
    }
>;
for (const [fileName, expectation] of Object.entries(expected)) {
    test(`real fixture: ${fileName}`, async () => {
        const bytes = await readFile(new URL(fileName, fixtures));
        const before = Buffer.from(bytes);
        const action = () =>
            parseRichDocument(
                bytes,
                fileName.endsWith('.pdf') ? PDF_MEDIA_TYPE : DOCX_MEDIA_TYPE
            );
        if (expectation.expectedError) {
            await assert.rejects(
                action,
                (error: unknown) =>
                    error instanceof DocumentParserError &&
                    error.code === expectation.expectedError
            );
            return;
        }
        const result = await action();
        assert.equal(result.schemaVersion, 1);
        assert.equal(
            result.sources.length,
            expectation.pages?.length ?? expectation.paragraphs?.length
        );
        assert.deepEqual(
            bytes,
            before,
            'caller input must remain available for its checksum/storage owner'
        );
        for (const [index, source] of result.sources.entries()) {
            assert.equal(source.index, index);
            assert.equal(
                source.start >= 0 && source.end <= result.text.length,
                true
            );
            const text = result.text.slice(source.start, source.end);
            if (expectation.pages) {
                assert.equal(source.page, index + 1);
                assert.equal(source.kind, 'pdf-page');
                assert.equal(text, expectation.pages[index]);
            } else {
                const paragraph = expectation.paragraphs![index]!;
                assert.equal(source.kind, 'docx-paragraph');
                assert.equal(source.paragraph, paragraph.paragraph);
                assert.equal(source.section, paragraph.section);
                if (paragraph.part) assert.equal(source.part, paragraph.part);
                if (paragraph.partIndex)
                    assert.equal(source.partIndex, paragraph.partIndex);
                if (paragraph.heading)
                    assert.equal(source.heading, paragraph.heading);
                assert.equal(text, paragraph.text);
                assert.equal(
                    source.page,
                    undefined,
                    'DOCX must not invent page numbers'
                );
            }
        }
        for (const excluded of expectation.excludedText ?? [])
            assert.ok(!result.text.includes(excluded));
        assert.deepEqual(
            result.warnings,
            (
                expectation.noTextSourceIndices ??
                (expectation.noTextPages ?? []).map((page) => page - 1)
            ).map((sourceIndex) => ({ code: 'NO_TEXT', sourceIndex }))
        );
    });
}

test('media type and input limits reject before parser startup', async () => {
    await assert.rejects(parseRichDocument(new Uint8Array([1]), 'text/html'), {
        code: 'FILE_INVALID',
    });
    await assert.rejects(
        parseRichDocument(
            new Uint8Array(LIMITS.inputBytes + 1),
            PDF_MEDIA_TYPE
        ),
        { code: 'PARSER_LIMIT' }
    );
});
test('bounded text and complete serialized artifact budgets', () => {
    const base: StructuredExtraction = {
        schemaVersion: 1,
        format: 'DOCX',
        text: 'x'.repeat(LIMITS.textBytes),
        sources: [
            {
                kind: 'docx-paragraph',
                index: 0,
                start: 0,
                end: LIMITS.textBytes,
                paragraph: 1,
                section: 1,
            },
        ],
        warnings: [],
    };
    assert.equal(validateExtraction(base), base);
    assert.throws(
        () => validateExtraction({ ...base, text: base.text + 'x' }),
        { code: 'PARSER_LIMIT' }
    );
    assert.throws(
        () =>
            validateExtraction({
                ...base,
                sources: Array.from({ length: 5000 }, (_, index) => ({
                    kind: 'docx-paragraph' as const,
                    index,
                    start: 0,
                    end: 0,
                    heading: '界'.repeat(200),
                })),
            }),
        { code: 'PARSER_LIMIT' }
    );
});
test('native output budget and total deadline are enforced', async () => {
    const source = new URL('text-fr-en.pdf', fixtures).pathname;
    await assert.rejects(
        runPoppler(
            '/usr/bin/pdftotext',
            ['-enc', 'UTF-8', source, '-'],
            Date.now() + 30_000,
            1
        ),
        { code: 'PARSER_LIMIT' }
    );
    await assert.rejects(
        runPoppler('/usr/bin/pdfinfo', [source], Date.now() - 1, 100),
        { code: 'PARSER_TIMEOUT' }
    );
});
test('native parser absence is an operator diagnostic, without command paths or document text', async () => {
    await assert.rejects(
        runPoppler(
            '/usr/bin/not-installed' as '/usr/bin/pdfinfo',
            [],
            Date.now() + 30_000,
            1000
        ),
        (error: unknown) => {
            assert.ok(error instanceof DocumentParserError);
            assert.equal(error.code, 'PARSER_UNAVAILABLE');
            assert.equal(error.message, 'PARSER_UNAVAILABLE');
            return true;
        }
    );
});
test('temporary private PDF files are cleaned after success and failure', async () => {
    const before = (await readdir('/tmp')).filter((name) =>
        name.startsWith('vectorix-parser-')
    );
    await parseRichDocument(
        await readFile(new URL('text-fr-en.pdf', fixtures)),
        PDF_MEDIA_TYPE
    );
    await assert.rejects(
        parseRichDocument(
            await readFile(new URL('corrupt.pdf', fixtures)),
            PDF_MEDIA_TYPE
        )
    );
    const after = (await readdir('/tmp')).filter((name) =>
        name.startsWith('vectorix-parser-')
    );
    assert.deepEqual(after, before);
});

/** File selection must never treat inherited JavaScript property names as supported extensions. */
test('media type selection ignores inherited and missing-dot extensions', async () => {
    const { mediaTypeForFile } =
        await import('../../packages/documents/src/index');
    for (const name of [
        'document.__proto__',
        'document.constructor',
        'document.toString',
        '__proto__',
        'pdf',
        'docx',
    ])
        assert.equal(mediaTypeForFile(name), undefined);
    assert.equal(mediaTypeForFile('GUIDE.PDF'), PDF_MEDIA_TYPE);
    assert.equal(mediaTypeForFile('guide.docx'), DOCX_MEDIA_TYPE);
});
