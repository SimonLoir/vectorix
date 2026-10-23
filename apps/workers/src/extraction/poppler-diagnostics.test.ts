import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPopplerResult } from './poppler-diagnostics';

const reconstruction =
    'Internal Error: xref num 1 not found but needed, try to reconstruct';
const success = (stderr: string) =>
    classifyPopplerResult({ code: 0, signal: null, stderr });

void test('clean output and exact bounded xref reconstruction lines permit successful extraction', () => {
    for (const stderr of [
        '',
        '\n\r\n\t \n',
        reconstruction,
        `${reconstruction}\n`,
        `${reconstruction}\r\n${reconstruction}\r\n`,
        reconstruction.replace('num 1 ', 'num 2147483647 '),
    ])
        assert.equal(success(stderr), null);
});

void test('xref object identifiers are positive bounded decimal values with no aliases', () => {
    for (const identifier of [
        '0',
        '-1',
        '+1',
        '01',
        '1.0',
        '1e3',
        '2147483648',
        '99999999999',
    ])
        assert.equal(
            success(reconstruction.replace('num 1 ', `num ${identifier} `)),
            'FILE_INVALID'
        );
});

void test('reconstruction is a whole-line exception, never a substring or blanket Syntax Warning allowance', () => {
    for (const stderr of [
        ` ${reconstruction}`,
        `${reconstruction} `,
        `${reconstruction}: trailing text`,
        `Document metadata: ${reconstruction}`,
        reconstruction.replace('Internal Error:', 'Syntax Warning:'),
        reconstruction.replace('try to reconstruct', 'try to reconstruct!'),
        'Syntax Warning: PDF file is damaged - attempting to reconstruct xref table...',
        'Unclassified native diagnostic',
        'cannot execute PDF operator: not found',
    ])
        assert.equal(success(stderr), 'FILE_INVALID');
});

void test('mixed xref recovery and partial-content corruption fail regardless of line order', () => {
    const corruption = [
        'Syntax Error: Unterminated string',
        'Syntax Error: Leftover args in content stream',
    ].join('\n');
    for (const stderr of [
        corruption,
        `${reconstruction}\n${corruption}`,
        `${corruption}\n${reconstruction}`,
        `${reconstruction}\nSyntax Error (42): Unknown operator`,
        `${reconstruction}\nSyntax Warning: damaged font`,
    ])
        assert.equal(success(stderr), 'FILE_INVALID');
});

void test('a nonzero exit cannot be rescued by a known reconstruction line', () => {
    for (const code of [1, 2, 3, 99, null])
        assert.equal(
            classifyPopplerResult({
                code,
                signal: null,
                stderr: reconstruction,
            }),
            'FILE_INVALID'
        );
});

void test('signal, launcher absence and encrypted nonzero precedence remain explicit', () => {
    assert.equal(
        classifyPopplerResult({
            code: 127,
            signal: 'SIGKILL',
            stderr: 'encrypted',
        }),
        'PARSER_LIMIT'
    );
    for (const code of [126, 127])
        assert.equal(
            classifyPopplerResult({ code, signal: null, stderr: 'encrypted' }),
            'PARSER_UNAVAILABLE'
        );
    assert.equal(
        classifyPopplerResult({
            code: 1,
            signal: null,
            stderr: 'prlimit: failed to execute /usr/bin/pdfinfo: No such file or directory',
        }),
        'PARSER_UNAVAILABLE'
    );
    for (const stderr of [
        'Command Line Error: Incorrect password',
        'Password required',
        'Encrypted document',
    ])
        assert.equal(
            classifyPopplerResult({ code: 1, signal: null, stderr }),
            'PDF_ENCRYPTED'
        );
    assert.equal(
        classifyPopplerResult({
            code: 1,
            signal: null,
            stderr: 'Syntax Error: xref object not found',
        }),
        'FILE_INVALID'
    );
});
