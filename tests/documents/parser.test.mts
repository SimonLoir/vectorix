import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { encodeStructuredExtraction } from '../../packages/documents/src/index';
import '../../apps/workers/src/extraction/poppler-diagnostics.test';
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
        canonicalSha256?: string;
        artifactSha256?: string;
        artifactBytes?: number;
        sourceRanges?: Array<{
            index: number;
            page: number;
            start: number;
            end: number;
        }>;
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
        if (expectation.canonicalSha256)
            assert.equal(
                createHash('sha256').update(result.text).digest('hex'),
                expectation.canonicalSha256
            );
        if (expectation.sourceRanges)
            assert.deepEqual(
                result.sources.map(({ index, page, start, end }) => ({
                    index,
                    page,
                    start,
                    end,
                })),
                expectation.sourceRanges
            );
        if (expectation.artifactSha256) {
            const artifact = encodeStructuredExtraction(result);
            assert.equal(artifact.byteLength, expectation.artifactBytes);
            assert.equal(
                createHash('sha256').update(artifact).digest('hex'),
                expectation.artifactSha256
            );
        }
        assert.deepEqual(
            result.warnings,
            (
                expectation.noTextSourceIndices ??
                (expectation.noTextPages ?? []).map((page) => page - 1)
            ).map((sourceIndex) => ({ code: 'NO_TEXT', sourceIndex }))
        );
    });
}

const executeNative = promisify(execFile);
/** Fixed synthetic fixtures only; inspect actual exit-zero stderr without the production classifier hiding it. */
async function nativePdf(
    executable: '/usr/bin/pdfinfo' | '/usr/bin/pdftotext',
    fileName: string
) {
    const path = new URL(fileName, fixtures).pathname;
    try {
        return await executeNative(
            '/usr/bin/prlimit',
            [
                '--cpu=5:5',
                '--as=536870912:536870912',
                '--nofile=64:64',
                '--',
                executable,
                '-enc',
                'UTF-8',
                ...(executable === '/usr/bin/pdftotext'
                    ? ['-eol', 'unix', path, '-']
                    : [path]),
            ],
            {
                env: {
                    PATH: '/usr/bin:/bin',
                    LANG: 'C',
                    LC_ALL: 'C',
                    TZ: 'UTC',
                },
                cwd: '/tmp',
                encoding: 'utf8',
                maxBuffer: 64 * 1024,
                timeout: 10_000,
                killSignal: 'SIGKILL',
            }
        );
    } catch {
        assert.fail(
            'The bounded synthetic native fixture must exit successfully.'
        );
    }
}

test('xref-only repair emits the actual known native diagnostic and preserves the complete baseline artifact', async () => {
    const diagnostic =
        'Internal Error: xref num 1 not found but needed, try to reconstruct';
    for (const executable of [
        '/usr/bin/pdfinfo',
        '/usr/bin/pdftotext',
    ] as const) {
        const result = await nativePdf(executable, 'xref-reconstructed.pdf');
        assert.equal(result.stderr, `${diagnostic}\n`);
        if (executable === '/usr/bin/pdftotext') {
            const baseline = await nativePdf(executable, 'text-fr-en.pdf');
            assert.equal(result.stdout, baseline.stdout);
        }
    }
    const baseline = await parseRichDocument(
        await readFile(new URL('text-fr-en.pdf', fixtures)),
        PDF_MEDIA_TYPE
    );
    const repaired = await parseRichDocument(
        await readFile(new URL('xref-reconstructed.pdf', fixtures)),
        PDF_MEDIA_TYPE
    );
    assert.deepEqual(repaired, baseline);
    assert.deepEqual(
        encodeStructuredExtraction(repaired),
        encodeStructuredExtraction(baseline)
    );
});

test('native optional linearization-length warnings preserve the complete baseline artifact, including with xref recovery', async () => {
    const baselineBytes = await readFile(new URL('text-fr-en.pdf', fixtures));
    const baselineText = await nativePdf(
        '/usr/bin/pdftotext',
        'text-fr-en.pdf'
    );
    const baseline = encodeStructuredExtraction(
        await parseRichDocument(baselineBytes, PDF_MEDIA_TYPE)
    );
    const warning = 'Syntax Warning: Length in linearization table is invalid';
    const repair =
        'Internal Error: xref num 1 not found but needed, try to reconstruct';
    for (const fileName of [
        'linearization-warning.pdf',
        'linearization-xref-reconstructed.pdf',
    ]) {
        const bytes = await readFile(new URL(fileName, fixtures));
        for (const executable of [
            '/usr/bin/pdfinfo',
            '/usr/bin/pdftotext',
        ] as const) {
            const result = await nativePdf(executable, fileName);
            const lines = result.stderr.trim().split(/\r?\n/u);
            assert.ok(
                lines.includes(warning),
                'The native tool must actually emit the accepted warning'
            );
            assert.ok(
                lines.every((line) => line === warning || line === repair)
            );
            assert.equal(
                lines.includes(repair),
                fileName === 'linearization-xref-reconstructed.pdf'
            );
            if (executable === '/usr/bin/pdftotext')
                assert.equal(
                    result.stdout,
                    baselineText.stdout,
                    'Every native text byte remains intact'
                );
        }
        assert.deepEqual(
            encodeStructuredExtraction(
                await parseRichDocument(bytes, PDF_MEDIA_TYPE)
            ),
            baseline,
            'The warning must not change canonical text, physical pages, source ranges or warnings'
        );
    }
});

test('a recoverable linearization warning cannot hide zero-exit partial-content corruption', async () => {
    for (const fileName of [
        'linearization-partial-corrupt.pdf',
        'linearization-xref-partial-corrupt.pdf',
    ]) {
        const native = await nativePdf('/usr/bin/pdftotext', fileName);
        assert.ok(
            native.stderr.includes(
                'Syntax Warning: Length in linearization table is invalid'
            )
        );
        assert.ok(native.stderr.includes('Syntax Error: Unterminated string'));
        assert.ok(
            native.stderr.includes(
                'Syntax Error: Leftover args in content stream'
            )
        );
        assert.ok(native.stdout.includes('Visible prefix page two.'));
        await assert.rejects(
            parseRichDocument(
                await readFile(new URL(fileName, fixtures)),
                PDF_MEDIA_TYPE
            ),
            { code: 'FILE_INVALID' }
        );
    }
});

test('exit-zero text-bearing partial corruption stays invalid even alongside the permitted xref repair', async () => {
    for (const fileName of [
        'partial-corrupt.pdf',
        'xref-partial-corrupt.pdf',
    ]) {
        const native = await nativePdf('/usr/bin/pdftotext', fileName);
        assert.ok(native.stdout.includes('Visible prefix page two.'));
        const lines = native.stderr.trimEnd().split('\n');
        assert.ok(lines.includes('Syntax Error: Unterminated string'));
        assert.ok(
            lines.includes('Syntax Error: Leftover args in content stream')
        );
        assert.equal(
            lines.includes(
                'Internal Error: xref num 1 not found but needed, try to reconstruct'
            ),
            fileName === 'xref-partial-corrupt.pdf'
        );
        await assert.rejects(
            parseRichDocument(
                await readFile(new URL(fileName, fixtures)),
                PDF_MEDIA_TYPE
            ),
            { code: 'FILE_INVALID' }
        );
    }
});

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
    for (const fileName of ['text-fr-en.pdf', 'xref-reconstructed.pdf'])
        await assert.rejects(
            runPoppler(
                '/usr/bin/pdftotext',
                ['-enc', 'UTF-8', new URL(fileName, fixtures).pathname, '-'],
                Date.now() + 30_000,
                1
            ),
            { code: 'PARSER_LIMIT' }
        );
    const source = new URL('xref-reconstructed.pdf', fixtures).pathname;
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
