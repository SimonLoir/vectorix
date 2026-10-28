import assert from 'node:assert/strict';
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
    discoverUnitTests,
    hasVitestDependency,
} from './unit-test-discovery.mjs';

const VITEST_FILE =
    'packages/routers/utils/src/utils/vectorix-features/external-provider.test.ts';
const VITEST_COMMAND =
    'vitest run src/utils/vectorix-features/external-provider.test.ts';

function fixture(run) {
    const base = mkdtempSync(join(tmpdir(), 'vectorix-unit-discovery-'));
    const root = join(base, 'repo');
    mkdirSync(join(root, 'apps'), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, 'packages'), { recursive: true, mode: 0o700 });
    function write(path, source) {
        const destination = join(root, path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, source, { mode: 0o600 });
    }
    function owner(directory, name, command) {
        write(
            `${directory}/package.json`,
            JSON.stringify({ scripts: { [name]: command } })
        );
    }
    try {
        run({ base, root, write, owner });
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
}

void test('syntax classification ignores comments and fixture literals but recognizes real framework dependencies', () => {
    for (const source of [
        '// import { test } from "vitest";\nimport { test } from "node:test";',
        '/* from "vitest" */ const value = "from \"vitest\"";',
        'const source = `import { expect } from "vitest"`;',
        'import value from "my-vitest";',
    ])
        assert.equal(hasVitestDependency(source, 'sample.test.ts'), false);
    for (const source of [
        'import { test } from "vitest";',
        'export { test } from "vitest";',
        'void import("vitest");',
        'const test = require("vitest");',
        'import test = require("vitest");',
        'import config from "vitest/config";',
    ])
        assert.equal(hasVitestDependency(source, 'sample.test.ts'), true);
});

void test('regular Node tests are sorted and Vitest-looking fixture text never hides them', () =>
    fixture(({ root, write }) => {
        write(
            'apps/web/z.test.ts',
            'const example = `import { test } from "vitest"`;'
        );
        write(
            'packages/a/a.test.tsx',
            '/* from "vitest" */ const element = <span />;'
        );
        write(
            'apps/api/a.test.ts',
            'throw new Error("Discovery must not execute fixtures");'
        );
        write('apps/api/not-a-test.ts', 'import { test } from "vitest";');
        assert.deepEqual(discoverUnitTests(root), [
            'apps/api/a.test.ts',
            'apps/web/z.test.ts',
            'packages/a/a.test.tsx',
        ]);
    }));

void test('file and directory symlinks cannot import external or native suites', () =>
    fixture(({ base, root, write }) => {
        write('apps/real.test.ts', 'import { test } from "node:test";');
        const outside = join(base, 'outside');
        mkdirSync(outside, { mode: 0o700 });
        const target = join(outside, 'integration.test.ts');
        writeFileSync(target, 'import { test } from "vitest";', {
            mode: 0o600,
        });
        symlinkSync(target, join(root, 'apps', 'alias.test.ts'));
        symlinkSync(outside, join(root, 'packages', 'external'));
        symlinkSync(
            join(outside, 'missing'),
            join(root, 'apps', 'broken.test.ts')
        );
        assert.deepEqual(discoverUnitTests(root), ['apps/real.test.ts']);
    }));

void test('generated outputs, fixture data and named integration suites retain their separate boundary', () =>
    fixture(({ root, write }) => {
        for (const directory of [
            'node_modules',
            'dist',
            '.next',
            '.turbo',
            'generated',
            'fixtures',
            '__fixtures__',
        ])
            write(
                `apps/api/${directory}/unsafe.test.ts`,
                'import { test } from "vitest";'
            );
        write('apps/api/integration.test.ts', 'import { test } from "vitest";');
        write(
            'apps/api/rag.integration.test.ts',
            'throw new Error("No service execution");'
        );
        write(
            'packages/safe/unit.test.ts',
            'import { test } from "node:test";'
        );
        assert.deepEqual(discoverUnitTests(root), [
            'packages/safe/unit.test.ts',
        ]);
    }));

void test('only the exact Vitest file owned by the actual workspace script is skipped', () =>
    fixture(({ root, write, owner }) => {
        owner('packages/routers/utils', 'test', VITEST_COMMAND);
        write(VITEST_FILE, 'import { test } from "vitest";');
        write(
            'packages/routers/utils/src/ordinary.test.ts',
            'const example = "from \"vitest\"";'
        );
        assert.deepEqual(discoverUnitTests(root), [
            'packages/routers/utils/src/ordinary.test.ts',
        ]);
    }));

void test('unowned Vitest tests fail clearly, including inside packages with another runner', () => {
    for (const path of [
        'apps/web/new.test.ts',
        'packages/chunking/tests/new.test.ts',
        'packages/config/tests/new.test.ts',
        'packages/routers/utils/src/new.test.ts',
    ])
        fixture(({ root, write }) => {
            write(path, 'import { test } from "vitest";');
            assert.throws(() => discoverUnitTests(root), {
                message: `Vitest test has no registered runner: ${path}`,
            });
        });
});

void test('changed Vitest script or converted framework cannot become an invisible test', () => {
    fixture(({ root, write, owner }) => {
        owner('packages/routers/utils', 'test', 'vitest run another.test.ts');
        write(VITEST_FILE, 'import { test } from "vitest";');
        assert.throws(() => discoverUnitTests(root), {
            message:
                'Test runner ownership changed: packages/routers/utils:test',
        });
    });
    fixture(({ root, write }) => {
        write(VITEST_FILE, 'import { test } from "node:test";');
        assert.throws(() => discoverUnitTests(root), {
            message: `Registered Vitest test no longer imports Vitest: ${VITEST_FILE}`,
        });
    });
});

void test('alternate runner patterns and script names match the actual isolated commands', () =>
    fixture(({ root, write, owner }) => {
        owner('packages/chunking', 'test', 'tsx --test tests/*.test.ts');
        owner('packages/config', 'test', 'tsx --test tests/*.test.ts');
        owner(
            'packages/embeddings',
            'test',
            'node --import tsx --test tests/*.test.ts'
        );
        owner(
            'packages/reranking',
            'test',
            'node --import tsx --test tests/*.test.ts'
        );
        owner(
            'packages/client',
            'test',
            'node --import tsx --test tests/*.test.ts'
        );
        owner(
            'packages/mcp',
            'test',
            'pnpm --filter @vectorix/client build && node --import tsx --test tests/*.test.ts'
        );
        owner('packages/vector-store', 'test:native', 'bash tests/run.sh');
        for (const path of [
            'packages/chunking/tests/new.test.ts',
            'packages/config/tests/runtime-config.test.ts',
            'packages/embeddings/tests/new.test.ts',
            'packages/reranking/tests/new.test.ts',
            'packages/client/tests/transport.test.ts',
            'packages/mcp/tests/stdio.test.ts',
            'packages/vector-store/tests/adapter.test.ts',
        ])
            write(
                path,
                'throw new Error("Only the owner may run this source");'
            );
        assert.deepEqual(discoverUnitTests(root), []);
    }));

void test('a test outside an alternate runner glob is rejected instead of silently lost', () => {
    for (const directory of ['packages/chunking', 'packages/config'])
        fixture(({ root, write, owner }) => {
            owner(directory, 'test', 'tsx --test tests/*.test.ts');
            const path = `${directory}/src/new.test.ts`;
            write(path, 'import { test } from "node:test";');
            assert.throws(() => discoverUnitTests(root), {
                message: `Test is outside its registered runner pattern: ${path}`,
            });
        });
});

void test('configuration runner script drift fails rather than hiding its tests', () =>
    fixture(({ root, write, owner }) => {
        owner('packages/config', 'test', 'tsx --test tests/another.test.ts');
        write(
            'packages/config/tests/runtime-config.test.ts',
            'import { test } from "node:test";'
        );
        assert.throws(() => discoverUnitTests(root), {
            message: 'Test runner ownership changed: packages/config:test',
        });
    }));

void test('the real checkout still includes security and parser units and excludes service suites', () => {
    const files = discoverUnitTests();
    assert.ok(
        files.includes(
            'apps/workers/src/extraction/poppler-diagnostics.test.ts'
        )
    );
    assert.ok(files.includes('apps/api/src/http/cookie-csrf-socket.test.ts'));
    assert.ok(
        files.includes(
            'packages/routers/utils/src/utils/notifications/push-endpoint-policy.test.ts'
        )
    );
    assert.equal(files.includes(VITEST_FILE), false);
    assert.equal(
        files.some((path) => path.startsWith('packages/config/')),
        false
    );
    assert.equal(
        files.some(
            (path) =>
                path.includes('integration') ||
                path.startsWith('packages/vector-store/')
        ),
        false
    );
    assert.equal(new Set(files).size, files.length);
    assert.deepEqual(files, [...files].sort());
});
