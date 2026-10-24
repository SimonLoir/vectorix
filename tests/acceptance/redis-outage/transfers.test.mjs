import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runPrivateCurl, assertCurlRoute, parseCurlResponse } from './curl.mjs';
import {
    multipartDocument,
    parseTransferArgs,
    readPinnedOriginal,
} from './transfers.mjs';
import { assessReadKey } from './key-policy.mjs';
const source = fs
    .readFileSync(new URL('./curl.mjs', import.meta.url), 'utf8')
    .replace(
        'export const STATIC_DRAFT_ONLY = true;',
        'export const STATIC_DRAFT_ONLY = false;'
    )
    .replace(
        "'../s3-outage/private.mjs'",
        JSON.stringify(
            new URL('../s3-outage/private.mjs', import.meta.url).href
        )
    );
const enabled = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);
const response = Buffer.from(
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'
);
function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-curl-'));
    fs.chmodSync(directory, 0o700);
    return {
        directory,
        origin: 'http://127.0.0.1:12345',
        route: '/api/auth/sign-in/email',
        method: 'POST',
        headers: [
            ['Cookie', 'synthetic-session'],
            ['Origin', 'http://127.0.0.1:12346'],
        ],
        body: Buffer.from('{"password":"synthetic"}'),
        curl: {
            path: '/usr/bin/curl',
            sha256: createHash('sha256')
                .update(fs.readFileSync('/usr/bin/curl'))
                .digest('hex'),
        },
        admit: () => {},
        remainingMilliseconds: () => 10000,
    };
}
test('disabled curl entry refuses before admission or filesystem access', () => {
    let called = false;
    assert.throws(
        () =>
            runPrivateCurl(
                {
                    admit: () => {
                        called = true;
                    },
                },
                () => {
                    called = true;
                }
            ),
        /DRAFT_REVIEW/u
    );
    assert.equal(called, false);
});
test('closed curl routes refuse arbitrary hosts, paths, queries and mutations', () => {
    assert.doesNotThrow(() =>
        assertCurlRoute(
            'http://127.0.0.1:12345',
            '/api/v1/admin/rag/documents/doc/original',
            'GET'
        )
    );
    for (const [origin, route, method] of [
        ['http://localhost:12345', '/api/auth/sign-in/email', 'POST'],
        ['http://127.0.0.1:12345', '/api/auth/sign-in/email?token=x', 'POST'],
        ['http://127.0.0.1:12345', '/api/v1/admin/rag/documents/doc', 'DELETE'],
        [
            'http://127.0.0.1:12345',
            '/api/v1/admin/rag/documents/../original',
            'GET',
        ],
    ])
        assert.throws(() => assertCurlRoute(origin, route, method));
});
test('enabled in-memory transport keeps secrets only in 0600 files, starts once with -q and clears every file', () => {
    const input = fixture();
    let calls = 0,
        admissions = 0;
    input.admit = () => {
        admissions++;
    };
    try {
        const result = enabled.runPrivateCurl(
            input,
            (binary, args, options) => {
                calls++;
                assert.equal(binary, '/usr/bin/curl');
                assert.equal(args[0], '-q');
                assert.equal(args[1], '--config');
                assert.equal(args.join(' ').includes('synthetic'), false);
                assert.equal(
                    JSON.stringify(options.env).includes('synthetic'),
                    false
                );
                const config = fs.readFileSync(args[2], 'utf8');
                assert.match(config, /proxy = ""/u);
                assert.match(config, /noproxy = "\*"/u);
                assert.match(config, /max-redirs = 0/u);
                assert.equal(config.includes('location'), false);
                assert.match(config, /Cookie: synthetic-session/u);
                assert.equal(fs.statSync(args[2]).mode & 0o777, 0o600);
                for (const file of fs.readdirSync(input.directory))
                    assert.equal(
                        fs.statSync(path.join(input.directory, file)).mode &
                            0o777,
                        0o600
                    );
                assert.equal(options.maxBuffer, 81920);
                assert.equal(options.timeout, 10000);
                assert.deepEqual(Object.keys(options.env).sort(), [
                    'LANG',
                    'LC_ALL',
                    'PATH',
                ]);
                return { status: 0, stdout: response };
            }
        );
        assert.equal(result.status, 200);
        assert.equal(calls, 1);
        assert.equal(admissions, 3);
        assert.deepEqual(fs.readdirSync(input.directory), []);
    } finally {
        fs.rmSync(input.directory, { recursive: true });
    }
});
test('unknown child acceptance, final admission failure and expired budget never return success or leave secret files', () => {
    for (const kind of ['child', 'guard', 'deadline']) {
        const input = fixture();
        let calls = 0,
            guards = 0;
        input.admit = () => {
            if (++guards === 3 && kind === 'guard')
                throw new Error('FIXED_GUARD_REFUSAL');
        };
        input.remainingMilliseconds = () => (kind === 'deadline' ? 0 : 10000);
        try {
            assert.throws(() =>
                enabled.runPrivateCurl(input, () => {
                    calls++;
                    return {
                        status: kind === 'child' ? 28 : 0,
                        stdout: response,
                    };
                })
            );
            assert.equal(calls, kind === 'deadline' ? 0 : 1);
            assert.deepEqual(fs.readdirSync(input.directory), []);
        } finally {
            fs.rmSync(input.directory, { recursive: true });
        }
    }
});
test('native response and headers are bounded and raw parser data never becomes diagnostics', () => {
    assert.equal(parseCurlResponse(response).status, 200);
    for (const bytes of [
        Buffer.alloc(81921),
        Buffer.from('PRIVATE_INVALID\r\n\r\n'),
        Buffer.from('HTTP/1.1 200 OK\r\nBadheader\r\n\r\n'),
    ])
        assert.throws(
            () => parseCurlResponse(bytes),
            (error) =>
                error.message.startsWith('S3_OUTAGE_CURL_') &&
                !error.message.includes('PRIVATE')
        );
});
test('multipart body preserves raw UTF-8 and native replacement expected version and seven-day input', () => {
    const bytes = Buffer.from('Français and English 🌉\n'),
        result = multipartDocument(bytes, 2, 'old-version');
    assert.equal(result.body.includes(bytes), true);
    assert.match(
        result.body.toString('utf8'),
        /name="retentionDays"\r\n\r\n7\r\n/u
    );
    assert.match(
        result.body.toString('utf8'),
        /name="expectedVersionId"\r\n\r\nold-version\r\n/u
    );
    assert.throws(() => multipartDocument(bytes, 2, 'foreign/route'));
});
test('minimum native read key must have exact issuer/principal, zero scopes and native audit; no delegated library write', () => {
    const f = {
            runId: '123456abcdef',
            organization: { id: 'org' },
            users: { owner: { userId: 'owner' } },
            membershipSnapshot: [{ id: 'member' }],
        },
        key = {
            id: 'key',
            configId: 'org',
            name: 'Redis read 123456abcdef',
            referenceId: 'org',
            enabled: true,
            vectorixLegacyFullAccess: false,
            expiresAt: null,
            permissions: '{"ragLibrary":["read"]}',
        },
        principal = { keyId: 'key', organizationId: 'org', memberId: 'member' },
        audit = {
            id: 'audit',
            organizationId: 'org',
            targetId: 'key',
            actorId: 'owner',
            actorType: 'user',
            action: 'apiKey.create',
            details: { collectionCount: 0 },
        };
    assert.equal(
        assessReadKey(key, [principal], 0, [audit], f, 'key').issuerUserId,
        'owner'
    );
    for (const delta of [
        { referenceId: 'foreign' },
        { enabled: false },
        { permissions: '{"ragLibrary":["read","write"]}' },
        { vectorixLegacyFullAccess: true },
    ])
        assert.throws(() =>
            assessReadKey(
                { ...key, ...delta },
                [principal],
                0,
                [audit],
                f,
                'key'
            )
        );
    assert.throws(() =>
        assessReadKey(
            key,
            [{ ...principal, memberId: 'foreign' }],
            0,
            [audit],
            f,
            'key'
        )
    );
    assert.throws(() => assessReadKey(key, [principal], 1, [audit], f, 'key'));
    assert.throws(() =>
        assessReadKey(
            key,
            [principal],
            0,
            [{ ...audit, actorId: 'foreign' }],
            f,
            'key'
        )
    );
});

test('transfer CLI keeps a closed fresh REDIS scenario and explicit unattended modes before context', () => {
    const valid = [
        '--run',
        '123456abcdef',
        '--scenario',
        'REDIS_V1',
        '--mode',
        'replace-v2',
    ];
    assert.deepEqual(parseTransferArgs(valid), {
        mode: 'replace-v2',
        purpose: 'staged-observe',
    });
    for (const value of [
        [],
        [...valid, '--retry'],
        valid.with(3, 'CLEANUP_V1'),
        valid.with(5, 'delete'),
        valid.with(1, '../foreign'),
        valid.with(0, '--state'),
    ])
        assert.throws(() => parseTransferArgs(value), /TRANSFER_ARGUMENTS/u);
});

test('fixed original reader enforces frozen byte/hash pins and refuses unknown fixture versions', () => {
    const metadata = JSON.parse(
            fs.readFileSync(
                new URL('../s3-outage/fixtures/expected.json', import.meta.url),
                'utf8'
            )
        ),
        state = {
            inputs: {
                textFixtures: Object.fromEntries(
                    metadata.versions.map((row) => [
                        row.fileName,
                        { bytes: row.bytes, sha256: row.sha256 },
                    ])
                ),
            },
        };
    for (const row of metadata.versions) {
        const bytes = readPinnedOriginal(state, row.version);
        assert.equal(bytes.length, row.bytes);
        assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            row.sha256
        );
    }
    assert.throws(() => readPinnedOriginal(state, 3));
    const tampered = structuredClone(state);
    tampered.inputs.textFixtures['s3-outage-v1.txt'].sha256 = '0'.repeat(64);
    assert.throws(() => readPinnedOriginal(tampered, 1), /FIXTURE_PIN/u);
});

test('curl pin reads the opened inode when the pathname is replaced before hashing', (t) => {
    const input = fixture(),
        binaryDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'redis-curl-pin-')
        ),
        binary = path.join(binaryDirectory, 'curl'),
        replacement = path.join(binaryDirectory, 'replacement'),
        approved = Buffer.from('approved synthetic executable'),
        changed = Buffer.from('replaced synthetic executable'),
        open = fs.openSync,
        stat = fs.fstatSync,
        read = fs.readFileSync;
    fs.writeFileSync(binary, approved, { mode: 0o755 });
    fs.writeFileSync(replacement, changed, { mode: 0o755 });
    input.curl.sha256 = createHash('sha256').update(approved).digest('hex');
    let descriptor,
        reads = 0,
        calls = 0;
    t.mock.method(fs, 'openSync', (file, ...args) => {
        if (file === input.curl.path) {
            descriptor = open(binary, ...args);
            return descriptor;
        }
        return open(file, ...args);
    });
    t.mock.method(fs, 'fstatSync', (file, ...args) => {
        const info = stat(file, ...args);
        if (file !== descriptor) return info;
        fs.renameSync(replacement, binary);
        // The controlled inode models the fixed system binary's root ownership.
        return { ...info, uid: 0, isFile: () => info.isFile() };
    });
    t.mock.method(fs, 'readFileSync', (file, ...args) => {
        if (file === descriptor) reads++;
        // A pathname read would observe the different replacement inode.
        return read(file === input.curl.path ? binary : file, ...args);
    });
    try {
        const result = enabled.runPrivateCurl(input, () => {
            calls++;
            assert.throws(() => stat(descriptor), { code: 'EBADF' });
            return { status: 0, stdout: response };
        });
        assert.equal(result.status, 200);
        assert.equal(calls, 1);
        assert.equal(reads, 1);
        assert.deepEqual(read(binary), changed);
        assert.deepEqual(fs.readdirSync(input.directory), []);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(input.directory, { recursive: true });
        fs.rmSync(binaryDirectory, { recursive: true });
    }
});

test('curl pin refuses a symlink at open before any child or secret file', (t) => {
    const input = fixture(),
        binaryDirectory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'redis-curl-link-')
        ),
        link = path.join(binaryDirectory, 'curl'),
        open = fs.openSync;
    fs.symlinkSync(input.curl.path, link);
    let calls = 0,
        binaryOpens = 0;
    t.mock.method(fs, 'openSync', (file, ...args) => {
        if (file === input.curl.path) {
            binaryOpens++;
            return open(link, ...args);
        }
        return open(file, ...args);
    });
    try {
        assert.throws(
            () =>
                enabled.runPrivateCurl(input, () => {
                    calls++;
                }),
            { code: 'ELOOP' }
        );
        assert.equal(binaryOpens, 1);
        assert.equal(calls, 0);
        assert.deepEqual(fs.readdirSync(input.directory), []);
    } finally {
        t.mock.restoreAll();
        fs.rmSync(input.directory, { recursive: true });
        fs.rmSync(binaryDirectory, { recursive: true });
    }
});

test('curl pin closes its descriptor on metadata, changed-size, hash and read failures without dispatch', (t) => {
    for (const kind of [
        'type',
        'owner',
        'mode',
        'size',
        'changed-size',
        'hash',
        'read',
    ]) {
        const input = fixture(),
            open = fs.openSync,
            stat = fs.fstatSync,
            read = fs.readFileSync,
            close = fs.closeSync;
        let descriptor,
            reads = 0,
            closes = 0,
            calls = 0;
        if (kind === 'hash') input.curl.sha256 = '0'.repeat(64);
        t.mock.method(fs, 'openSync', (file, ...args) => {
            const value = open(file, ...args);
            if (file === input.curl.path) descriptor = value;
            return value;
        });
        t.mock.method(fs, 'fstatSync', (file, ...args) => {
            const info = stat(file, ...args);
            if (file !== descriptor) return info;
            return {
                ...info,
                uid: kind === 'owner' ? 1000 : 0,
                mode: kind === 'mode' ? 0o100777 : info.mode,
                size:
                    kind === 'size'
                        ? 16 * 1024 * 1024 + 1
                        : kind === 'changed-size'
                          ? info.size - 1
                          : info.size,
                isFile: () => kind !== 'type' && info.isFile(),
            };
        });
        t.mock.method(fs, 'readFileSync', (file, ...args) => {
            if (file === descriptor) {
                reads++;
                if (kind === 'read') throw new Error('CONTROLLED_READ_FAILURE');
            }
            return read(file, ...args);
        });
        t.mock.method(fs, 'closeSync', (file) => {
            if (file === descriptor) closes++;
            return close(file);
        });
        try {
            assert.throws(
                () =>
                    enabled.runPrivateCurl(input, () => {
                        calls++;
                    }),
                kind === 'read'
                    ? /CONTROLLED_READ_FAILURE/u
                    : /S3_OUTAGE_CURL_PIN/u
            );
            assert.equal(
                reads,
                ['changed-size', 'hash', 'read'].includes(kind) ? 1 : 0
            );
            assert.equal(closes, 1);
            assert.throws(() => stat(descriptor), { code: 'EBADF' });
            assert.equal(calls, 0);
            assert.deepEqual(fs.readdirSync(input.directory), []);
        } finally {
            t.mock.restoreAll();
            fs.rmSync(input.directory, { recursive: true });
        }
    }
});
