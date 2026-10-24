#!/usr/bin/env node
/**
 * Discover and run the workspace's Node unit tests with tsx, replacing the
 * hand-maintained file list in apps/api. Every `*.test.ts(x)` file under apps/
 * and packages/ runs unless it is:
 * - an integration suite (`*integration*`), which needs databases and runs through `test:integration`;
 * - a Vitest file (imports `vitest`), which its package's own `test` script runs;
 * - inside a package listed in OWN_RUNNERS, whose `test` script runs it through Turborepo.
 *
 * Usage: node scripts/unit-tests.mjs [--list] [--coverage]
 * Runs from any cwd that can resolve `tsx` (apps/api's `test` script).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_ROOTS = ['apps', 'packages'];
const SKIPPED_DIRECTORIES = new Set([
    'node_modules',
    'dist',
    '.next',
    '.turbo',
    'generated',
]);
// Packages whose own `test` script owns their tests (native/Docker or their own globs).
const OWN_RUNNERS = [
    'packages/chunking',
    'packages/embeddings',
    'packages/vector-store',
];
const TEST_FILE = /\.test\.tsx?$/u;
const VITEST_IMPORT = /from\s+['"]vitest['"]/u;

function* walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name))
                yield* walk(join(directory, entry.name));
        } else if (TEST_FILE.test(entry.name))
            yield join(directory, entry.name);
    }
}

/** Return repository-relative unit test paths in a stable order. */
export function discoverUnitTests() {
    const files = [];
    for (const searchRoot of SEARCH_ROOTS)
        for (const file of walk(join(root, searchRoot))) {
            const path = relative(root, file).split(sep).join('/');
            if (OWN_RUNNERS.some((prefix) => path.startsWith(`${prefix}/`)))
                continue;
            if (path.split('/').at(-1).includes('integration')) continue;
            if (VITEST_IMPORT.test(readFileSync(file, 'utf8'))) continue;
            files.push(path);
        }
    return files.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const files = discoverUnitTests();
    if (process.argv.includes('--list')) {
        for (const file of files) console.log(file);
        process.exit(0);
    }
    if (files.length === 0) {
        console.error('No unit tests were discovered.');
        process.exit(1);
    }
    const args = [
        '--test',
        ...(process.argv.includes('--coverage')
            ? ['--experimental-test-coverage']
            : []),
        ...files.map((file) => relative(process.cwd(), join(root, file))),
    ];
    const result = spawnSync('tsx', args, { stdio: 'inherit', shell: false });
    process.exit(result.status ?? 1);
}
