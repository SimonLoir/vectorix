/** Pure mock setup protocol; no filesystem, SDK, HTTP, Docker or database operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DRAFT_ONLY,
    initializeQualityBucket,
    validateBucketState,
    validateBucketGuard,
} from './quality-bucket.mjs';

const run = 'abcdef012345';
function state() {
    return {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId: run,
        prefix: 'vectorix-m7c-quality-' + run,
        phase: 'APP_DB_EMPTY_SCHEMA_REQUIRED',
        ports: { rustfs: 45104 },
        environment: {
            VECTORIX_DEFAULT_S3_ENDPOINT: 'http://127.0.0.1:45104',
            VECTORIX_S3_ALLOWED_ENDPOINTS: 'http://127.0.0.1:45104',
            VECTORIX_DEFAULT_S3_BUCKET: 'm7c-quality-' + run,
            VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
            VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE: 'true',
            VECTORIX_DEFAULT_S3_ACCESS_KEY_ID: 'm7c-quality-' + run,
            VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY: 'a'.repeat(32),
        },
    };
}
function adapters(options = {}) {
    const trace = [];
    let created = false;
    const proofs = [];
    return {
        trace,
        proofs,
        api: {
            listBuckets: async () => {
                trace.push('list');
                return options.existing
                    ? ['foreign']
                    : created
                      ? ['m7c-quality-' + run]
                      : [];
            },
            createBucket: async (value) => {
                trace.push(['create', value]);
                created = true;
            },
            headBucket: async (value) => trace.push(['head', value]),
            getBucketVersioning: async () => options.versioning ?? {},
            listObjects: async () =>
                options.objects ?? { Contents: [], IsTruncated: false },
        },
        anonymousList: async () => options.anonymousStatus ?? 403,
        checkpoint: async (proof) => proofs.push(proof),
    };
}
test('reviewed initializer binds only its exact new local bucket', () => {
    assert.equal(DRAFT_ONLY, false);
    validateBucketState(state(), run);
    for (const mutate of [
        (value) => (value.runId = '111111111111'),
        (value) => (value.phase = 'READY_FOR_QUALITY_IMPORT'),
        (value) =>
            (value.environment.VECTORIX_DEFAULT_S3_ENDPOINT =
                'https://example.test'),
        (value) => (value.environment.VECTORIX_DEFAULT_S3_BUCKET = 'foreign'),
        (value) =>
            (value.environment.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID = 'another'),
    ]) {
        const value = state();
        mutate(value);
        assert.throws(() => validateBucketState(value, run));
    }
});
test('independent proof must affirm exact run purpose ownership read-only empty DB', () => {
    const value = {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId: run,
        purpose: 'bucket',
        resourceOwnership: true,
        databaseReadOnly: true,
        bootstrapFreshness: true,
    };
    validateBucketGuard(value, run);
    for (const key of [
        'resourceOwnership',
        'databaseReadOnly',
        'bootstrapFreshness',
    ])
        assert.throws(() =>
            validateBucketGuard({ ...value, [key]: false }, run)
        );
    assert.throws(() =>
        validateBucketGuard({ ...value, purpose: 'bootstrap' }, run)
    );
});
test('new private unversioned empty bucket setup has finite exact native actions', async () => {
    const io = adapters();
    const proof = await initializeQualityBucket({ state: state(), ...io });
    assert.deepEqual(io.trace, [
        'list',
        ['create', 'm7c-quality-' + run],
        ['head', 'm7c-quality-' + run],
        'list',
    ]);
    assert.equal(proof.completed, true);
    assert.equal(io.proofs.length, 1);
    assert.equal(
        proof.coverage,
        'OWNED_BUCKET_SETUP_ONLY_NOT_ALL_OBJECT_PRIVACY_OR_BACKUP'
    );
    assert(!JSON.stringify(proof).includes('a'.repeat(32)));
});
test('existing bucket never gets adopted or made public', async () => {
    const io = adapters({ existing: true });
    await assert.rejects(
        initializeQualityBucket({ state: state(), ...io }),
        /QUALITY_BUCKET_REQUIRES_EMPTY_STORE/u
    );
    assert.deepEqual(io.trace, ['list']);
    assert.equal(io.proofs.length, 0);
});
test('versioning existing content and public anonymous access fail before proof output', async () => {
    for (const options of [
        { versioning: { Status: 'Enabled' } },
        { versioning: { MFADelete: 'Disabled' } },
        { objects: { Contents: [{ Key: 'unknown' }] } },
        { objects: { IsTruncated: true } },
        { anonymousStatus: 200 },
        { anonymousStatus: 307 },
        { anonymousStatus: 404 },
    ]) {
        const io = adapters(options);
        await assert.rejects(
            initializeQualityBucket({ state: state(), ...io })
        );
        assert.equal(io.proofs.length, 0);
    }
});
test('a failed checkpoint cannot produce a returned successful setup proof', async () => {
    const io = adapters();
    await assert.rejects(
        initializeQualityBucket({
            state: state(),
            ...io,
            checkpoint: async () => {
                throw new Error('SYNTHETIC_CHECKPOINT_REFUSAL');
            },
        }),
        /SYNTHETIC_CHECKPOINT_REFUSAL/u
    );
});
