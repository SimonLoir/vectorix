/** Owned local files only. No processes, credentials, Docker, database, HTTP or model calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import {
    privateCheckpoint,
    privateDirectory,
    readPrivate,
} from './load-private.mjs';

function ownedDirectory(work) {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-load-private-')
    );
    try {
        fs.chmodSync(directory, 0o700);
        return work(directory);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
}

test('exclusive and replacement journals preserve600 and fsync file then directory before returning', () => {
    ownedDirectory((directory) => {
        const filename = path.join(directory, 'journal.json');
        const original = fs.fsyncSync;
        const observed = [];
        const spy = mock.method(fs, 'fsyncSync', (handle) => {
            observed.push(
                fs.fstatSync(handle).isDirectory() ? 'directory' : 'file'
            );
            return original(handle);
        });
        try {
            privateDirectory(directory);
            privateCheckpoint(filename, { stage: 1 }, true);
            assert.deepEqual(observed, ['file', 'directory']);
            assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
            assert.deepEqual(JSON.parse(readPrivate(filename, 1024)), {
                stage: 1,
            });
            assert.throws(
                () => privateCheckpoint(filename, { stage: 99 }, true),
                { code: 'EEXIST' }
            );
            assert.deepEqual(JSON.parse(readPrivate(filename, 1024)), {
                stage: 1,
            });
            observed.length = 0;
            privateCheckpoint(filename, { stage: 2 });
            assert.deepEqual(observed, ['file', 'directory']);
            assert.deepEqual(JSON.parse(readPrivate(filename, 1024)), {
                stage: 2,
            });
            assert.equal(fs.existsSync(filename + '.next'), false);
        } finally {
            spy.mock.restore();
        }
    });
});

test('directory fsync failure is surfaced so callers cannot treat a journal as durable before mutation', () => {
    ownedDirectory((directory) => {
        const original = fs.fsyncSync;
        const spy = mock.method(fs, 'fsyncSync', (handle) => {
            if (fs.fstatSync(handle).isDirectory())
                throw new Error('SYNTHETIC_DIRECTORY_SYNC_FAILURE');
            return original(handle);
        });
        try {
            assert.throws(
                () =>
                    privateCheckpoint(
                        path.join(directory, 'journal.json'),
                        { stage: 1 },
                        true
                    ),
                /SYNTHETIC_DIRECTORY_SYNC_FAILURE/u
            );
        } finally {
            spy.mock.restore();
        }
    });
});

test('private reads and checkpoints reject symlinks, over-limit files and unsafe modes', () => {
    ownedDirectory((directory) => {
        const filename = path.join(directory, 'journal.json');
        privateCheckpoint(filename, { stage: 1 }, true);
        assert.throws(() => readPrivate(filename, 1), /LOAD_PRIVATE_FILE/u);
        const link = path.join(directory, 'link.json');
        fs.symlinkSync(filename, link);
        assert.throws(() => readPrivate(link, 1024));
        assert.throws(() => privateCheckpoint(link, { stage: 99 }, true));
        fs.chmodSync(filename, 0o644);
        assert.throws(() => readPrivate(filename, 1024), /LOAD_PRIVATE_FILE/u);
        assert.throws(
            () => privateCheckpoint(filename, { stage: 99 }),
            /LOAD_CHECKPOINT_EXISTING_FILE/u
        );
    });
});
