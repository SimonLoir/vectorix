#!/usr/bin/env node
/**
 * Run discovered workspace Node tests from the API package's pnpm environment.
 * Discovery only reads regular source files and verifies alternate runners;
 * native/integration suites remain separate. See docs/testing.md.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverUnitTests } from './unit-test-discovery.mjs';
export { discoverUnitTests } from './unit-test-discovery.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
