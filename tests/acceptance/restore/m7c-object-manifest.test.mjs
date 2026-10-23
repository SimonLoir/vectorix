/** Pure tests only: imports no SDK/client and performs no file/network/database operations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LIMITS,
    ObjectGuardError,
    canonical,
    sha256,
    validateState,
    validateFixture,
    validateKey,
    validateDestination,
    objectHeaders,
    validateObjectBytes,
    buildManifest,
    publicManifest,
    mimeDiagnosticClass,
    storedObjectContentType,
} from './m7c-object-manifest.mjs';
const run = '0123456789ab',
    version = '00000000-0000-4000-8000-000000000001';
const org = 'org-a',
    doc = 'doc-a';
function fixture() {
    const endpoint = 'http://127.0.0.1:45000';
    const state = {
        version: 1,
        runId: run,
        prefix: 'vectorix-m7c-restore-' + run,
        applicationDatabase: 'vectorix_m7c_app_' + run + '_test',
        vectorDatabase: 'vectorix_m7c_vectors_' + run + '_test',
        ports: { rustfs: 45000, postgres: 45001 },
        buckets: ['m7c-' + run + '-platform', 'm7c-' + run + '-organization'],
        infrastructureSecrets: {
            s3Access: 'm7c-' + run,
            s3Secret: 'x'.repeat(48),
        },
        environment: {
            VECTORIX_DEFAULT_S3_ENDPOINT: endpoint,
            VECTORIX_S3_ALLOWED_ENDPOINTS: endpoint,
            VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
            VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE: 'true',
            VECTORIX_DEFAULT_S3_BUCKET: 'm7c-' + run + '-platform',
            VECTORIX_DEFAULT_S3_ACCESS_KEY_ID: 'm7c-' + run,
            VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY: 'x'.repeat(48),
            DATABASE_URL:
                'postgresql://postgres:synthetic@127.0.0.1:45001/vectorix_m7c_app_' +
                run +
                '_test',
        },
    };
    const accepted = {
        runId: run,
        prefix: state.prefix,
        organizationIds: ['org-a', 'org-b'],
        documentIds: ['doc-a', 'doc-b'],
    };
    const bytes = Buffer.from('Bonjour world\n');
    const original = {
        bucket: state.buckets[0],
        key: org + '/' + doc + '/' + version + '/original',
        blob: 'object-0000.bin',
        ...validateObjectBytes(
            bytes,
            bytes.length,
            objectHeaders({
                ContentType: 'text/plain',
                Metadata: { sha256: sha256(bytes) },
            })
        ),
    };
    const binding = {
        kind: 'ORIGINAL',
        id: version,
        versionId: version,
        organizationId: org,
        documentId: doc,
        storageLocationId: 'location-a',
        storageFingerprint: 'a'.repeat(64),
        credentialId: null,
        credentialRevision: null,
        credentialBinding: 'PLATFORM',
        endpoint,
        region: 'us-east-1',
        bucket: original.bucket,
        forcePathStyle: true,
        key: original.key,
        expectedBytes: bytes.length,
        catalogSha256: sha256(bytes),
        expectedContentType: 'text/plain',
        requiredPresent: true,
        contentState: 'AVAILABLE',
        discardedAt: null,
        extractorVersion: null,
    };
    const organizations = { 'doc-a': 'org-a', 'doc-b': 'org-b' };
    return { state, accepted, bytes, original, binding, organizations };
}
const rejects = (fn, label) =>
    assert.throws(
        fn,
        (error) => error instanceof ObjectGuardError && error.message === label
    );
function manifest(
    f = fixture(),
    bindings = [f.binding],
    objects = [f.original]
) {
    return buildManifest(
        f.state,
        f.accepted,
        bindings,
        objects,
        f.organizations
    );
}

test('deterministic canonical manifest and safe aggregate omit object keys and synthetic credentials', () => {
    const f = fixture(),
        first = manifest(f),
        second = JSON.parse(canonical(first));
    assert.equal(canonical(first), canonical(second));
    const summary = publicManifest(first);
    assert.equal(summary.objects, 1);
    assert.equal(summary.bytes, f.bytes.length);
    assert.equal(summary.originalBindings, 1);
    assert.equal(summary.extractionBindings, 0);
    assert.match(summary.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(summary.catalogBindingSha256, /^[a-f0-9]{64}$/);
    const text = JSON.stringify(summary);
    assert(!text.includes(f.original.key));
    assert(!text.includes(f.state.infrastructureSecrets.s3Secret));
    assert(!text.includes('Bonjour'));
});
test('reject application DSN, wrong run, endpoint, bucket, port and platform credential substitutions', () => {
    for (const mutate of [
        (value) => {
            value.environment.DATABASE_URL =
                value.environment.DATABASE_URL.replace('_test', '');
        },
        (value) => {
            value.runId = 'abcdefabcdef';
        },
        (value) => {
            value.environment.VECTORIX_DEFAULT_S3_ENDPOINT =
                'http://outside.test';
        },
        (value) => {
            value.buckets[1] = 'other-bucket';
        },
        (value) => {
            value.ports.rustfs = 0;
        },
        (value) => {
            value.environment.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY = 'wrong';
        },
    ]) {
        const f = fixture();
        mutate(f.state);
        assert.throws(() => validateState(f.state, run), ObjectGuardError);
    }
});
test('fixture requires completed bounded exact synthetic organizations and documents', () => {
    for (const mutate of [
        (value) => {
            value.documentIds = [];
        },
        (value) => {
            value.documentIds = ['doc-a', 'doc-a'];
        },
        (value) => {
            value.organizationIds.push('org-c');
        },
        (value) => {
            value.runId = 'abcdefabcdef';
        },
    ]) {
        const f = fixture();
        mutate(f.accepted);
        assert.throws(
            () => validateFixture(f.state, f.accepted),
            ObjectGuardError
        );
    }
});
test('keys and saved destinations cannot escape accepted organization/document/version/bucket', () => {
    const f = fixture();
    for (const key of [
        '../doc-a/' + version + '/original',
        'org-a/doc-b/' + version + '/original',
        'org-a/doc-a/not-a-uuid/original',
        'org-a/doc-a/' + version + '/original/extra',
        'org-a/doc-a/' + version + '/unknown',
    ]) {
        assert.throws(
            () => validateKey(key, f.accepted, f.organizations),
            ObjectGuardError
        );
    }
    const location = { ...f.binding },
        config = {
            ...location,
            accessKeyId: 'explicit',
            secretAccessKey: 'explicit',
        };
    validateDestination(f.state, location, config);
    rejects(
        () =>
            validateDestination(f.state, location, {
                ...config,
                bucket: f.state.buckets[1],
            }),
        'bound-storage-destination-drift'
    );
    rejects(
        () =>
            validateDestination(
                f.state,
                { ...location, endpoint: 'http://outside.test' },
                config
            ),
        'saved-owned-storage-destination'
    );
    rejects(
        () =>
            validateDestination(f.state, location, {
                ...config,
                secretAccessKey: '',
            }),
        'bound-storage-credentials-required'
    );
});
test('actual bytes are checked independently from advertised length and metadata hashes', () => {
    const f = fixture(),
        head = objectHeaders({ Metadata: { sha256: sha256(f.bytes) } });
    rejects(
        () => validateObjectBytes(Buffer.from('tampered'), 8, head),
        'actual-metadata-sha-mismatch'
    );
    rejects(
        () => validateObjectBytes(f.bytes, f.bytes.length + 1, head),
        'actual-object-byte-cap'
    );
    rejects(
        () =>
            validateObjectBytes(Buffer.alloc(0), LIMITS.objectBytes + 1, head),
        'head-object-byte-cap'
    );
    rejects(
        () => objectHeaders({ Metadata: { sha256: 'UPPERCASE' } }),
        'sha-metadata-shape'
    );
});
test('unknown missing metadata and extraction database hashes are explicit, never inferred', () => {
    const f = fixture();
    const extraction = {
        ...f.original,
        key: f.original.key.replace('/original', '/text.txt'),
        ...validateObjectBytes(
            f.bytes,
            f.bytes.length,
            objectHeaders({ ContentType: 'text/plain; charset=utf-8' })
        ),
    };
    const binding = {
        ...f.binding,
        id: 'extraction-a',
        kind: 'EXTRACTION',
        key: extraction.key,
        expectedContentType: 'text/plain; charset=utf-8',
        catalogSha256: null,
        extractorVersion: 'plain-text-v1',
    };
    const result = manifest(f, [binding], [extraction]);
    assert.equal(result.bindings[0].databaseHashState, 'NOT_STORED');
    assert.equal(result.unknowns.missingShaMetadata, 1);
    assert.equal(result.unknowns.databaseExtractionHashesNotStored, 1);
});
test('required missing content fails; explicitly discarded absent objects remain absent', () => {
    const f = fixture();
    rejects(
        () => manifest(f, [f.binding], []),
        'required-catalog-object-missing'
    );
    const result = manifest(
        f,
        [
            {
                ...f.binding,
                requiredPresent: false,
                contentState: 'PURGED',
                discardedAt: '2026-10-23T00:00:00.000Z',
            },
        ],
        []
    );
    assert.equal(result.bindings[0].presence, 'ABSENT_ALLOWED');
    assert.equal(result.unknowns.allowedAbsentUnavailableObjects, 1);
});
test('catalog originals require exact hash, byte size, type, key and credential identities', () => {
    const f = fixture();
    for (const [changes, label] of [
        [{ catalogSha256: 'b'.repeat(64) }, 'catalog-original-sha'],
        [{ expectedBytes: 1 }, 'catalog-object-size'],
        [
            { expectedContentType: 'application/json' },
            'catalog-object-content-type-original-expected-json-actual-plain',
        ],
        [
            { versionId: '00000000-0000-4000-8000-000000000002' },
            'exact-version-object-binding',
        ],
        [{ credentialBinding: 'ORGANIZATION' }, 'credential-binding-policy'],
        [{ requiredPresent: false }, 'binding-presence-policy'],
    ]) {
        rejects(() => manifest(f, [{ ...f.binding, ...changes }]), label);
    }
});
test('owned unreferenced orphan objects are included in snapshot with explicit coverage', () => {
    const f = fixture();
    const orphan = {
        ...f.original,
        blob: 'object-0001.bin',
        key: f.original.key.replace(
            version,
            'ffffffff-ffff-4fff-8fff-ffffffffffff'
        ),
    };
    const result = manifest(f, [f.binding], [orphan, f.original]);
    assert.equal(result.objects.length, 2);
    assert.equal(result.unknowns.unreferencedObjects, 1);
    assert.equal(
        result.coverage,
        'QUIESCED_CURRENT_OBJECTS_ONLY_NO_VERSION_HISTORY_OR_CLOUD_POLICY_BACKUP'
    );
});
test('flat blob names, duplicate objects and extra unreviewed inventory fields fail', () => {
    const f = fixture();
    rejects(
        () => manifest(f, [f.binding], [{ ...f.original, blob: '../escape' }]),
        'flat-private-blob'
    );
    rejects(
        () =>
            manifest(
                f,
                [f.binding],
                [f.original, { ...f.original, blob: 'object-0001.bin' }]
            ),
        'duplicate-object'
    );
    rejects(
        () => manifest(f, [f.binding], [{ ...f.original, unreviewed: true }]),
        'noncanonical-inventory-fields'
    );
});
test('object, aggregate byte, metadata and binding bounds are enforced with bounded fixtures', () => {
    const f = fixture();
    rejects(
        () =>
            manifest(
                f,
                [],
                Array.from({ length: LIMITS.objects + 1 }, () => f.original)
            ),
        'manifest-count-bound'
    );
    const many = Array.from({ length: 33 }, (_, index) => ({
        ...f.original,
        blob: 'object-' + String(index).padStart(4, '0') + '.bin',
        bytes: LIMITS.objectBytes,
        key:
            org +
            '/' +
            doc +
            '/' +
            String(index).padStart(8, '0') +
            '-0000-4000-8000-000000000001/original',
    }));
    rejects(() => manifest(f, [], many), 'inventory-total-cap');
    rejects(
        () =>
            objectHeaders({
                Metadata: Object.fromEntries(
                    Array.from({ length: 33 }, (_, index) => [
                        'key' + index,
                        'x',
                    ])
                ),
            }),
        'bounded-object-metadata'
    );
    rejects(
        () => objectHeaders({ ServerSideEncryption: 'AES256' }),
        'unhandled-encryption-or-redirect'
    );
    for (const indicator of [
        { TagCount: 1 },
        { ObjectLockLegalHoldStatus: 'ON' },
        { VersionId: 'historical-version' },
        { MissingMeta: 1 },
        { DeleteMarker: true },
        { Restore: 'ongoing-request=true' },
        { StorageClass: 'GLACIER' },
        { PartsCount: 2 },
        { Expiration: 'unhandled-rule' },
        { ReplicationStatus: 'COMPLETE' },
    ]) {
        rejects(
            () => objectHeaders(indicator),
            'unhandled-object-policy-or-version'
        );
    }
    objectHeaders({
        TagCount: 0,
        MissingMeta: 0,
        DeleteMarker: false,
        StorageClass: 'STANDARD',
        VersionId: 'null',
    });
});
test('canonical representation rejects non-finite, fractional and unsupported prototype values', () => {
    for (const value of [NaN, Infinity, 0.5, new Date(), undefined])
        assert.throws(() => canonical(value), ObjectGuardError);
    assert.equal(
        canonical({ b: 1, a: ['é', null, true] }),
        '{"a":["é",null,true],"b":1}'
    );
});

test('MIME failure diagnostics use finite classes, distinguish charset spacing and preserve strict refusal', () => {
    for (const [value, expected] of [
        [null, 'missing'],
        ['text/plain', 'plain'],
        ['text/plain;charset=utf-8', 'plain-utf8-tight'],
        ['text/plain; charset=utf-8', 'plain-utf8-space'],
        ['text/plain;  charset = utf-8', 'plain-utf8-ows'],
        ['text/markdown', 'markdown'],
        ['application/json; charset=utf-8', 'json-utf8-space'],
        ['application/pdf', 'pdf'],
        [
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'docx',
        ],
        ['application/octet-stream', 'binary'],
        ['synthetic-unknown-sensitive-header', 'other'],
    ])
        assert.equal(mimeDiagnosticClass(value), expected);
    const f = fixture();
    f.original.headers.contentType = 'text/plain;charset=utf-8';
    rejects(
        () => manifest(f),
        'catalog-object-content-type-original-expected-plain-actual-plain-utf8-tight'
    );
    for (const kind of ['original', 'extraction'])
        for (const expected of [
            'markdown-utf8-space',
            'markdown-utf8-tight',
            'markdown-utf8-ows',
        ])
            for (const actual of [
                'markdown-utf8-space',
                'markdown-utf8-tight',
                'markdown-utf8-ows',
            ])
                assert.match(
                    `catalog-object-content-type-${kind}-expected-${expected}-actual-${actual}`,
                    /^[a-z][a-z0-9-]{1,100}$/u
                );
});

test('physical original MIME is binary independently of filename, while extraction suffixes have exact writer MIME', () => {
    for (const fileName of [
        'original',
        'guide.md',
        'text.txt',
        'document.pdf',
        'report.docx',
        'unknown.extension',
    ])
        assert.equal(
            storedObjectContentType('ORIGINAL', 'owned/version/' + fileName),
            'application/octet-stream'
        );
    assert.equal(
        storedObjectContentType('EXTRACTION', 'owned/version/text.txt'),
        'text/plain; charset=utf-8'
    );
    assert.equal(
        storedObjectContentType('EXTRACTION', 'owned/version/extraction.json'),
        'application/json; charset=utf-8'
    );
    rejects(
        () =>
            storedObjectContentType('EXTRACTION', 'owned/version/unknown.json'),
        'stored-extraction-suffix'
    );
    rejects(
        () => storedObjectContentType('UNKNOWN', 'owned/version/original'),
        'stored-object-kind'
    );
    rejects(
        () => storedObjectContentType('ORIGINAL', ''),
        'stored-object-key-required'
    );
    const f = fixture();
    f.binding.expectedContentType = storedObjectContentType(
        'ORIGINAL',
        f.binding.key
    );
    rejects(
        () => manifest(f),
        'catalog-object-content-type-original-expected-binary-actual-plain'
    );
    f.original.headers.contentType = 'application/octet-stream';
    assert.equal(
        manifest(f).objects[0].headers.contentType,
        'application/octet-stream'
    );
});
