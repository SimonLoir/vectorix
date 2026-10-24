import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
    STATIC_DRAFT_ONLY,
    OBJECT_LIMITS,
    assertOnlineObjectPhase,
    assertObjectDescriptor,
    readBoundedObjectBody,
    createReadOnlyObjectObserver,
} from './objects.mjs';

const bytes = Buffer.from('Texte français et English — 🌉\n', 'utf8');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const state = {
    ports: { rustfs: 19000 },
    environment: {
        VECTORIX_DEFAULT_S3_BUCKET: 'owned-bucket',
        VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
    },
};
const fixture = { organization: { id: 'org' } };
const bindings = [
    {
        documentId: 'doc',
        versionId: 'v1',
        version: 1,
        sha256,
        byteSize: bytes.length,
        extractionPresent: true,
    },
    {
        documentId: 'doc',
        versionId: 'v2',
        version: 2,
        sha256,
        byteSize: bytes.length,
        extractionPresent: false,
    },
];
const descriptor = {
    organizationId: 'org',
    documentId: 'doc',
    versionId: 'v1',
    key: 'org/doc/v1/original',
    kind: 'original',
    byteSize: bytes.length,
    expectedSha256: sha256,
    location: {
        organizationId: 'org',
        credentialId: null,
        endpoint: 'http://127.0.0.1:19000',
        bucket: 'owned-bucket',
        region: 'us-east-1',
        forcePathStyle: true,
    },
};

function reader(parts) {
    let cancelled = false,
        released = false;
    return {
        read: async () =>
            parts.length
                ? { value: parts.shift(), done: false }
                : { done: true },
        cancel: async () => {
            cancelled = true;
        },
        releaseLock: () => {
            released = true;
        },
        cleaned: () => cancelled && released,
    };
}

void test('the disabled object entry refuses before admission, SDK lookup or any transport construction', () => {
    assert.equal(STATIC_DRAFT_ONLY, true);
    let admissions = 0;
    assert.throws(
        () =>
            createReadOnlyObjectObserver({
                state,
                fixture,
                bindings,
                phase: 'v1-ready',
                admit: () => {
                    admissions++;
                },
            }),
        /DRAFT_REVIEW_REQUIRED/u
    );
    assert.equal(admissions, 0);
    assert.deepEqual(OBJECT_LIMITS, {
        objectBytes: 65536,
        totalBytes: 262144,
        requests: 9,
        deadlineMs: 30000,
        getMs: 5000,
    });
});
void test('descriptors permit only exact platform-bound owned version keys, hashes and sizes', () => {
    assert.equal(
        assertObjectDescriptor(descriptor, state, fixture, bindings),
        'org/doc/v1/original'
    );
    const artifact = {
        ...descriptor,
        key: 'org/doc/v2/text.txt',
        versionId: 'v2',
        kind: 'artifact',
    };
    assert.equal(
        assertObjectDescriptor(artifact, state, fixture, bindings),
        'org/doc/v2/text.txt'
    );
    for (const change of [
        { organizationId: 'foreign' },
        { documentId: 'foreign' },
        { versionId: 'unknown' },
        { key: 'org/doc/v1/../original' },
        { expectedSha256: '0'.repeat(64) },
        { byteSize: bytes.length + 1 },
        { kind: 'put' },
        {
            location: {
                ...descriptor.location,
                endpoint: 'http://127.0.0.2:19000',
            },
        },
        {
            location: {
                ...descriptor.location,
                credentialId: 'organization-credential',
            },
        },
        { location: { ...descriptor.location, bucket: 'another-bucket' } },
    ])
        assert.throws(
            () =>
                assertObjectDescriptor(
                    { ...descriptor, ...change },
                    state,
                    fixture,
                    bindings
                ),
            /S3_OUTAGE_OBJECT_/u
        );
});
void test('the production pre-SDK phase predicate always refuses outage and unknown phases independently of the draft flag', () => {
    for (const phase of [
        'v1-ready',
        'v2-staged',
        'restored-before-retry',
        'v2-ready',
        'signed-out',
    ])
        assert.doesNotThrow(() => assertOnlineObjectPhase(phase));
    for (const phase of [
        'outage-failed',
        'outage-progress',
        'unknown',
        '../v1-ready',
        null,
    ])
        assert.throws(
            () => assertOnlineObjectPhase(phase),
            /ONLINE_ADMISSION/u
        );
});
void test('the complete fragmented UTF-8 body retains exact bytes and hash and releases its reader', async () => {
    const input = reader([
        bytes.subarray(0, 7),
        bytes.subarray(7, bytes.length - 2),
        bytes.subarray(bytes.length - 2),
    ]);
    const result = await readBoundedObjectBody(input, {
        byteSize: bytes.length,
        expectedSha256: sha256,
        deadline: 100,
        now: () => 0,
    });
    assert.deepEqual(result, bytes);
    assert.equal(input.cleaned(), true);
});
void test('oversize, short, malformed-type and wrong-hash bodies fail without returning partial success', async () => {
    for (const parts of [
        [Buffer.concat([bytes, Buffer.from('x')])],
        [bytes.subarray(1)],
        ['not-byte-data'],
        [new Uint8Array(0)],
    ]) {
        const input = reader(parts);
        await assert.rejects(
            readBoundedObjectBody(input, {
                byteSize: bytes.length,
                expectedSha256: sha256,
                deadline: 100,
                now: () => 0,
            }),
            /S3_OUTAGE_OBJECT_BODY_/u
        );
        assert.equal(input.cleaned(), true);
    }
    const input = reader([bytes]);
    await assert.rejects(
        readBoundedObjectBody(input, {
            byteSize: bytes.length,
            expectedSha256: '0'.repeat(64),
            deadline: 100,
            now: () => 0,
        }),
        /BODY_SHA/u
    );
    assert.equal(input.cleaned(), true);
});
void test('body deadline covers delayed reads and cleanup, including a read that never settles', async () => {
    let clock = 0;
    const delayed = {
        read: async () => {
            clock = 501;
            return { value: bytes, done: false };
        },
        cancel: async () => {},
        releaseLock: () => {},
    };
    await assert.rejects(
        readBoundedObjectBody(delayed, {
            byteSize: bytes.length,
            expectedSha256: sha256,
            deadline: 500,
            now: () => clock,
        }),
        /OBJECT_DEADLINE/u
    );
    let cancelled = false,
        released = false;
    const hanging = {
        read: () => new Promise(() => {}),
        cancel: async () => {
            cancelled = true;
        },
        releaseLock: () => {
            released = true;
        },
    };
    await assert.rejects(
        readBoundedObjectBody(hanging, {
            byteSize: bytes.length,
            expectedSha256: sha256,
            deadline: performance.now() + 5,
        }),
        /OBJECT_DEADLINE/u
    );
    assert.equal(cancelled, true);
    assert.equal(released, true);
});
