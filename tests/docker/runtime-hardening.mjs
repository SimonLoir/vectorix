import assert from 'node:assert/strict';
import {
    closeSync,
    constants,
    mkdtempSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Passed on stdin to a fresh image as its configured USER, without starting the
// application or mounting /app read-only: permissions must enforce the refusal.
const targets = {
    api: {
        directories: ['/app/dist'],
        files: ['/app/package.json', '/app/dist/index.mjs'],
    },
    workers: {
        directories: ['/app/dist'],
        files: ['/app/package.json', '/app/dist/index.mjs'],
    },
    migrator: {
        directories: ['/app/packages/db', '/app/packages/db/prisma'],
        files: [
            '/app/packages/db/package.json',
            '/app/packages/db/prisma.config.ts',
            '/app/packages/db/prisma/schema.prisma',
            '/app/packages/db/node_modules/prisma/build/index.js',
        ],
    },
    web: frontend('web'),
    admin: frontend('admin'),
};
const app = process.env.TEST_APP;
assert.ok(
    Object.hasOwn(targets, app),
    'Only the five smoke images are admitted'
);
assert.ok(
    process.getuid() > 0 && process.geteuid() > 0,
    'Actual UID must be nonroot'
);
const target = targets[app];

/** Known standalone layout; its cache is the only tested writable app path. */
function frontend(name) {
    const base = `/app/apps/${name}`;
    return {
        directories: [
            base,
            `${base}/.next`,
            `${base}/.next/server`,
            `${base}/.next/static`,
        ],
        files: [`${base}/package.json`, `${base}/server.js`],
        cache: `${base}/.next/cache`,
    };
}

/** A filesystem refusal, rather than a read-only mount or user-name assertion. */
function assertPermissionRefusal(error) {
    assert.ok(
        error && (error.code === 'EACCES' || error.code === 'EPERM'),
        'Expected a filesystem permission refusal'
    );
}

for (const directory of ['/app', '/app/node_modules', ...target.directories]) {
    const info = statSync(directory);
    assert.ok(
        info.isDirectory() && info.uid === 0,
        'Application directories must remain root-owned'
    );
    let created;
    try {
        created = mkdtempSync(join(directory, '.vectorix-permission-check-'));
    } catch (error) {
        assertPermissionRefusal(error);
    }
    if (created) rmSync(created, { recursive: true });
    assert.equal(
        created,
        undefined,
        'Runtime USER must not create application files'
    );
}
for (const file of target.files) {
    const info = statSync(file);
    assert.ok(
        info.isFile() && info.uid === 0,
        'Application files must remain root-owned'
    );
    let writable = false;
    try {
        // O_WRONLY tests real write admission without truncating or changing code.
        const descriptor = openSync(file, constants.O_WRONLY);
        closeSync(descriptor);
        writable = true;
    } catch (error) {
        assertPermissionRefusal(error);
    }
    assert.equal(
        writable,
        false,
        'Runtime USER must not open application code for writing'
    );
}
if (target.cache) {
    assert.ok(
        statSync(target.cache).isDirectory(),
        'Standalone cache must exist'
    );
    const owned = mkdtempSync(join(target.cache, '.vectorix-cache-check-'));
    try {
        const original = join(owned, 'original');
        const renamed = join(owned, 'renamed');
        writeFileSync(original, 'cache-one', { flag: 'wx', mode: 0o600 });
        assert.equal(readFileSync(original, 'utf8'), 'cache-one');
        writeFileSync(original, 'cache-two');
        renameSync(original, renamed);
        assert.equal(readFileSync(renamed, 'utf8'), 'cache-two');
        rmSync(renamed);
    } finally {
        rmSync(owned, { recursive: true });
    }
}
console.log(
    `Production ${app} UID, protected application paths and cache checks passed`
);
