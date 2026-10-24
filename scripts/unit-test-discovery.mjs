import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_ROOTS = ['apps', 'packages'];
const SKIPPED_DIRECTORIES = new Set([
    'node_modules',
    'dist',
    '.next',
    '.turbo',
    'generated',
    'fixtures',
    '__fixtures__',
]);
const TEST_FILE = /\.test\.tsx?$/u;

// These scripts have different runtimes or isolation requirements. Verify both
// the actual script and the paths it covers instead of skipping whole packages.
const OWN_RUNNERS = [
    {
        directory: 'packages/config',
        name: 'test',
        command: 'tsx --test tests/*.test.ts',
        files: /^packages\/config\/tests\/[^/]+\.test\.ts$/u,
    },
    {
        directory: 'packages/chunking',
        name: 'test',
        command: 'tsx --test tests/*.test.ts',
        files: /^packages\/chunking\/tests\/[^/]+\.test\.ts$/u,
    },
    {
        directory: 'packages/embeddings',
        name: 'test',
        command: 'node --import tsx --test tests/*.test.ts',
        files: /^packages\/embeddings\/tests\/[^/]+\.test\.ts$/u,
    },
    {
        directory: 'packages/vector-store',
        name: 'test:native',
        command: 'bash tests/run.sh',
        files: /^packages\/vector-store\/tests\/adapter\.test\.ts$/u,
    },
];
const VITEST_OWNERS = new Map([
    [
        'packages/routers/utils/src/utils/vectorix-features/external-provider.test.ts',
        {
            directory: 'packages/routers/utils',
            name: 'test',
            command:
                'vitest run src/utils/vectorix-features/external-provider.test.ts',
        },
    ],
]);

/** @param {string} value */
function isVitestSpecifier(value) {
    return value === 'vitest' || value.startsWith('vitest/');
}

/**
 * Inspect syntax without executing test code. Comments and string fixtures do
 * not declare a framework; real static imports/exports and literal import() or
 * require() calls do, and must have an explicit verified owner.
 * @param {string} source
 * @param {string} filename
 */
export function hasVitestDependency(source, filename) {
    const parsed = ts.createSourceFile(
        filename,
        source,
        ts.ScriptTarget.Latest,
        false,
        filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    let found = false;
    /** @param {import('typescript').Node} node */
    function visit(node) {
        /** @type {import('typescript').Expression | undefined} */
        let specifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            specifier = node.moduleSpecifier;
        else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        )
            specifier = node.moduleReference.expression;
        else if (
            ts.isCallExpression(node) &&
            node.arguments.length === 1 &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) &&
                    node.expression.text === 'require'))
        )
            specifier = node.arguments[0];
        if (
            specifier &&
            ts.isStringLiteralLike(specifier) &&
            isVitestSpecifier(specifier.text)
        )
            found = true;
        if (!found) ts.forEachChild(node, visit);
    }
    visit(parsed);
    return found;
}

/** @param {string} directory @returns {Generator<string>} */
function* walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        // Dirent.isDirectory/isFile are both false for symlinks. Do not follow
        // aliases to native tests, generated/private fixtures or external files.
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRECTORIES.has(entry.name))
                yield* walk(join(directory, entry.name));
        } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
            yield join(directory, entry.name);
        }
    }
}

/**
 * Discover Node tests in stable order and fail if a claimed alternate runner
 * cannot prove ownership. The root argument is used by hermetic filesystem
 * tests; the CLI always uses this checkout. Native suites are never started.
 * @param {string} [root]
 * @returns {string[]}
 */
export function discoverUnitTests(root = DEFAULT_ROOT) {
    const files = [];
    const verified = new Set();
    /** @param {{directory: string, name: string, command: string}} owner */
    function verifyOwner(owner) {
        const identity = `${owner.directory}:${owner.name}:${owner.command}`;
        if (verified.has(identity)) return;
        const manifest = JSON.parse(
            readFileSync(join(root, owner.directory, 'package.json'), 'utf8')
        );
        if (manifest.scripts?.[owner.name] !== owner.command)
            throw new Error(
                `Test runner ownership changed: ${owner.directory}:${owner.name}`
            );
        verified.add(identity);
    }
    for (const searchRoot of SEARCH_ROOTS) {
        for (const file of walk(join(root, searchRoot))) {
            const path = relative(root, file).split(sep).join('/');
            if ((path.split('/').at(-1) ?? '').includes('integration'))
                continue;
            const vitest = hasVitestDependency(
                readFileSync(file, 'utf8'),
                path
            );
            const vitestOwner = VITEST_OWNERS.get(path);
            if (vitest) {
                if (!vitestOwner)
                    throw new Error(
                        `Vitest test has no registered runner: ${path}`
                    );
                verifyOwner(vitestOwner);
                continue;
            }
            if (vitestOwner)
                throw new Error(
                    `Registered Vitest test no longer imports Vitest: ${path}`
                );
            const ownRunner = OWN_RUNNERS.find((owner) =>
                path.startsWith(`${owner.directory}/`)
            );
            if (ownRunner) {
                if (!ownRunner.files.test(path))
                    throw new Error(
                        `Test is outside its registered runner pattern: ${path}`
                    );
                verifyOwner(ownRunner);
                continue;
            }
            files.push(path);
        }
    }
    return files.sort();
}
