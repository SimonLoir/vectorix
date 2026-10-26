import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, describe, it } from 'node:test';
import { ESLint, Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import policy from '../unicorn-63-policy.json' with { type: 'json' };
import { unicorn63Config, unicorn63Plugin } from '../unicorn-63-compat.js';
import noHexEscape from '../no-hex-escape.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const offByPrettier = new Set([
    'unicorn/empty-brace-spaces',
    'unicorn/no-nested-ternary',
    'unicorn/number-literal-case',
    'unicorn/template-indent',
]);
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, child]) => [key, stable(child)])
        );
    return value;
}
function sourceFile(directory, extension) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name, 'en')
    )) {
        if (
            ['node_modules', 'generated', 'tests', '.next'].includes(entry.name)
        )
            continue;
        const file = path.join(directory, entry.name);
        if (entry.isFile() && entry.name.endsWith(extension)) return file;
        if (entry.isDirectory()) {
            const nested = sourceFile(file, extension);
            if (nested) return nested;
        }
    }
}
function projects() {
    const result = [];
    for (const parent of ['apps', 'packages', 'packages/routers']) {
        for (const entry of readdirSync(path.join(root, parent), {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory()) continue;
            const directory = path.join(root, parent, entry.name);
            const manifest = path.join(directory, 'package.json');
            if (
                !existsSync(manifest) ||
                !existsSync(path.join(directory, 'eslint.config.js'))
            )
                continue;
            const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
            if (pkg.scripts?.lint) result.push({ directory, name: pkg.name });
        }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

test('the versioned policy snapshot remains the independently reviewed version 63 baseline', () => {
    assert.equal(policy.source.version, '63.0.0');
    assert.equal(Object.keys(policy.rules).length, 142);
    assert.equal(Object.keys(policy.globals).length, 62);
    assert.equal(
        createHash('sha256')
            .update(JSON.stringify(stable(policy)))
            .digest('hex'),
        '0d95639d18c65fb3f59a7340a206a85a85a2d2dbf3f23e15fd296fab7ef0af3c'
    );
    assert.deepEqual(unicorn63Config.languageOptions.globals, policy.globals);
    assert.deepEqual(policy.coreRules, {
        'no-negated-condition': 'off',
        'no-nested-ternary': 'off',
    });
    assert.equal(
        Object.hasOwn(unicorn63Config.rules, 'no-process-exit'),
        false
    );
});

test('real configs in every lint workspace preserve exactly 111 live legacy checks, core rules and globals', async (t) => {
    const found = projects();
    assert.equal(found.length, 26);
    for (const project of found) {
        await t.test(project.name, async () => {
            const sourceDirectory = path.join(
                project.directory,
                existsSync(path.join(project.directory, 'src')) ? 'src' : 'app'
            );
            const files = ['.ts', '.tsx']
                .map((extension) => sourceFile(sourceDirectory, extension))
                .filter(Boolean);
            assert.ok(files.length > 0, project.name);
            const eslint = new ESLint({
                cwd: project.directory,
                overrideConfigFile: path.join(
                    project.directory,
                    'eslint.config.js'
                ),
            });
            for (const file of files) {
                const config = await eslint.calculateConfigForFile(file);
                assert.ok(config, file);
                let enabled = 0;
                for (const [name, level] of Object.entries(policy.rules)) {
                    const expected =
                        level === 'error' && !offByPrettier.has(name) ? 2 : 0;
                    assert.equal(
                        config.rules[name]?.[0],
                        expected,
                        `${project.name}:${name}`
                    );
                    if (expected === 2) {
                        enabled++;
                        const implementation =
                            config.plugins.unicorn.rules[
                                name.slice('unicorn/'.length)
                            ];
                        assert.equal(
                            typeof implementation?.create,
                            'function',
                            name
                        );
                        assert.equal(
                            Boolean(implementation.meta.deprecated),
                            false,
                            name
                        );
                    }
                }
                assert.equal(enabled, 111);
                const expectedActive = Object.entries(policy.rules)
                    .filter(
                        ([name, level]) =>
                            level === 'error' && !offByPrettier.has(name)
                    )
                    .map(([name]) => name)
                    .sort();
                const actualActive = Object.entries(config.rules)
                    .filter(
                        ([name, configured]) =>
                            name.startsWith('unicorn/') && configured[0] !== 0
                    )
                    .map(([name]) => name)
                    .sort();
                assert.equal(expectedActive.length, 111);
                assert.deepEqual(
                    actualActive,
                    expectedActive,
                    `${project.name}:${path.extname(file)}`
                );

                for (const [name, configured] of Object.entries(
                    unicorn63Config.rules
                )) {
                    if (Array.isArray(configured))
                        assert.deepEqual(
                            config.rules[name],
                            [2, ...configured.slice(1)],
                            name
                        );
                }
                assert.equal(config.rules['no-negated-condition'][0], 0);
                assert.equal(config.rules['no-nested-ternary'][0], 0);
                for (const name of Object.keys(policy.globals))
                    assert.ok(
                        [false, 'readonly', 'readable'].includes(
                            config.languageOptions.globals[name]
                        ),
                        name
                    );
            }
        });
    }
});

test('compatibility aliases are live and the original version 78 plugin remains unchanged', () => {
    assert.notEqual(unicorn63Plugin, unicorn);
    assert.notEqual(unicorn63Plugin.rules, unicorn.rules);
    assert.equal(
        unicorn63Plugin.rules['no-array-for-each'],
        unicorn.rules['no-for-each']
    );
    assert.equal(
        unicorn63Plugin.rules['prefer-dom-node-dataset'],
        unicorn.rules['dom-node-dataset']
    );
    assert.equal(unicorn63Plugin.rules['no-hex-escape'], noHexEscape);
    assert.equal(Object.hasOwn(unicorn.rules, 'no-array-for-each'), false);
    assert.ok(unicorn.rules['no-hex-escape'].meta.deprecated);
    assert.ok(unicorn.rules['prefer-dom-node-dataset'].meta.deprecated);
    assert.notEqual(unicorn.rules['no-hex-escape'], noHexEscape);
});

function messages(
    name,
    code,
    options = unicorn63Config.rules[`unicorn/${name}`]
) {
    return new Linter().verify(
        code,
        [
            {
                files: ['**/*.ts', '**/*.tsx'],
                languageOptions: {
                    parser: tseslint.parser,
                    ecmaVersion: 'latest',
                    sourceType: 'module',
                    parserOptions: { ecmaFeatures: { jsx: true } },
                },
                plugins: { unicorn: unicorn63Plugin },
                rules: { [`unicorn/${name}`]: options },
            },
        ],
        { filename: 'fixture.tsx' }
    );
}
function reports(name, code, count, options) {
    const actual = messages(name, code, options);
    assert.equal(
        actual.some((item) => item.fatal),
        false,
        JSON.stringify(actual)
    );
    assert.equal(actual.length, count, `${name}: ${code}`);
}

test('both old alias IDs execute real replacement checks', () => {
    reports(
        'no-array-for-each',
        'const values = [1, 2]; values.forEach(value => console.log(value));',
        1,
        'error'
    );
    reports(
        'prefer-dom-node-dataset',
        'element.getAttribute("data-name");',
        1,
        'error'
    );
});

test('changed defaults preserve empty-file, ignored-hole and legacy alias fallback coverage', () => {
    reports('no-empty-file', '// ordinary comment', 1);
    reports('no-empty-file', '/// <reference types="node" />', 0);
    reports('no-empty-file', 'export const value = 1;', 0);
    reports('no-unreadable-array-destructuring', 'const [,,value] = input;', 1);
    reports('no-unreadable-array-destructuring', 'const [a,,b] = input;', 0);
    reports(
        'prefer-default-parameters',
        'function f(value) { value = value || 1; return value; }',
        1
    );
    reports(
        'prefer-default-parameters',
        'function f(value) { const alias = value || 1; return alias; }',
        1
    );
    reports(
        'prefer-default-parameters',
        'function f(value) { const alias = value || 1; return alias; }',
        0,
        ['error', { checkFallbackExpressions: false }]
    );
    reports(
        'prefer-default-parameters',
        'function f(value) { return value ?? 1; }',
        1
    );
});

test('old fraction grouping is explicit while integer and base grouping stay checked', () => {
    reports(
        'numeric-separators-style',
        'const a = 0.000_000_000_1; const b = -0.123_456_789;',
        0
    );
    reports('numeric-separators-style', 'const a = 0.000_000_000_1;', 1, [
        'error',
    ]);
    reports(
        'numeric-separators-style',
        'const a = 12_345; const b = 0xAB_CD;',
        0
    );
    reports(
        'numeric-separators-style',
        'const a = 12345; const b = 0xABCD;',
        2
    );
});

test('retained engine expansions stay visible rather than being switched off', () => {
    reports(
        'prefer-ternary',
        'function f(x) { if (x) return 1; else return 2; }',
        1
    );
    reports(
        'prefer-ternary',
        'function f(x) { if (x) return 1; return 2; }',
        1
    );
    reports(
        'prefer-ternary',
        'if (x) socket.write("a"); else socket.write("b");',
        1
    );
    reports(
        'prefer-set-has',
        'const values = [1, 2]; function f(x) { return values.includes(x); }',
        1
    );
    reports(
        'prefer-set-has',
        'const values = input.map(x => x); function f(x) { return values.includes(x); }',
        1
    );
    reports(
        'no-negated-condition',
        'const value = !a || !b ? 1 : 2;',
        1,
        'error'
    );
    reports(
        'prefer-type-error',
        'if (!Number.isFinite(value)) throw new Error("invalid");',
        1,
        'error'
    );
});

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({
    languageOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        parserOptions: { ecmaFeatures: { jsx: true } },
    },
});
const hex = (code, output, count = 1) => ({
    code,
    output,
    filename: 'fixture.tsx',
    errors: Array.from({ length: count }, () => ({
        messageId: 'no-hex-escape',
    })),
});
tester.run('actual legacy hexadecimal escape compatibility', noHexEscape, {
    valid: [
        String.raw`const a = "\\x41";`,
        String.raw`const a = "\\\\x41";`,
        String.raw`const a = String.raw\`\x41\`;`.replaceAll('\\`', '`'),
        String.raw`const a = /\\x41/;`,
        String.raw`const a = new RegExp("\\x41");`,
        String.raw`const a = "\u0041";`,
    ],
    invalid: [
        hex(String.raw`const a = "\x41";`, String.raw`const a = "\u0041";`),
        hex(
            String.raw`const a = "\x00\x80\xFF";`,
            String.raw`const a = "\u0000\u0080\u00FF";`
        ),
        hex(
            String.raw`const a = "\x22\x27\x5C";`,
            String.raw`const a = "\u0022\u0027\u005C";`
        ),
        hex(String.raw`const a = "\\\x41";`, String.raw`const a = "\\\u0041";`),
        hex(
            'const a = `\\x41${n}\\x80`;',
            'const a = `\\u0041${n}\\u0080`;',
            2
        ),
        hex('const a = tag`\\x41`;', 'const a = tag`\\u0041`;'),
        hex(
            'const a = String["raw"]`\\x41`;',
            'const a = String["raw"]`\\u0041`;'
        ),
        hex(
            'const raw = String.raw; const a = raw`\\x41`;',
            'const raw = String.raw; const a = raw`\\u0041`;'
        ),
        hex('const a = tag`\\xG1`;', 'const a = tag`\\u00G1`;'),
        hex(
            String.raw`const a = <X title="\x41"/>;`,
            String.raw`const a = <X title="\u0041"/>;`
        ),
        hex(
            String.raw`const a = <X title={"\x41"}/>;`,
            String.raw`const a = <X title={"\u0041"}/>;`
        ),
        hex(
            String.raw`const a = /\x41\x00\xFF/u;`,
            String.raw`const a = /\u0041\u0000\u00FF/u;`
        ),
        hex(
            String.raw`const a = /[\x41-\x5A]/v;`,
            String.raw`const a = /[\u0041-\u005A]/v;`
        ),
        hex(String.raw`const a = /\x41\8/;`, String.raw`const a = /\u0041\8/;`),
        hex(String.raw`const a = /\xG1/;`, String.raw`const a = /\u00G1/;`),
        hex(String.raw`"\x75se strict";`, String.raw`"\u0075se strict";`),
    ],
});

test('stock78 replacements cannot silently stand in for JSX and custom-tag coverage', () => {
    for (const code of [
        String.raw`const a = <X title="\x41"/>;`,
        'const a = tag`\\x41`;',
    ]) {
        reports('no-hex-escape', code, 1, 'error');
        for (const name of [
            'prefer-literal-ascii',
            'prefer-unicode-code-point-escapes',
        ])
            reports(name, code, 0, 'error');
    }
});
