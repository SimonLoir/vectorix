/** Pure mock setup protocol; no filesystem, SDK, HTTP, Docker or database operation. */
import test from 'node:test';
import { getLoadPolicy, policySha256 } from './load-policy-registry.mjs';
const defaultPolicy = getLoadPolicy('DEFAULT_V1');
import assert from 'node:assert/strict';
import {
    DRAFT_ONLY,
    initializeLoadBucket,
    validateBucketState,
    validateBucketGuard,
} from './load-bucket.mjs';

const run = 'abcdef012345';
function state() {
    return {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-load',
        experimentPolicyId: defaultPolicy.id,
        experimentPolicySha256: policySha256(defaultPolicy),
        loadPolicy: structuredClone(defaultPolicy.loadPolicy),
        runId: run,
        prefix: 'vectorix-m7c-load-' + run,
        phase: 'APP_DB_EMPTY_SCHEMA_REQUIRED',
        ports: { rustfs: 45104 },
        environment: {
            VECTORIX_DEFAULT_S3_ENDPOINT: 'http://127.0.0.1:45104',
            VECTORIX_S3_ALLOWED_ENDPOINTS: 'http://127.0.0.1:45104',
            VECTORIX_DEFAULT_S3_BUCKET: 'm7c-load-' + run,
            VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
            VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE: 'true',
            VECTORIX_DEFAULT_S3_ACCESS_KEY_ID: 'm7c-load-' + run,
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
                      ? ['m7c-load-' + run]
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
test('initializer binds only its exact new local bucket', () => {
    assert.equal(typeof DRAFT_ONLY, 'boolean');
    validateBucketState(state(), run);
    for (const mutate of [
        (value) => (value.runId = '111111111111'),
        (value) => (value.phase = 'READY_FOR_LOAD_IMPORT'),
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
        namespace: 'vectorix-m7c-load',
        experimentPolicyId: defaultPolicy.id,
        experimentPolicySha256: policySha256(defaultPolicy),
        runId: run,
        purpose: 'bucket',
        resourceOwnership: true,
        databaseReadOnly: true,
        bootstrapFreshness: true,
    };
    validateBucketGuard(value, run, defaultPolicy);
    for (const key of [
        'resourceOwnership',
        'databaseReadOnly',
        'bootstrapFreshness',
    ])
        assert.throws(() =>
            validateBucketGuard({ ...value, [key]: false }, run, defaultPolicy)
        );
    assert.throws(() =>
        validateBucketGuard(
            { ...value, purpose: 'bootstrap' },
            run,
            defaultPolicy
        )
    );
});
test('new private unversioned empty bucket setup has finite exact native actions', async () => {
    const io = adapters();
    const proof = await initializeLoadBucket({ state: state(), ...io });
    assert.deepEqual(io.trace, [
        'list',
        ['create', 'm7c-load-' + run],
        ['head', 'm7c-load-' + run],
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
        initializeLoadBucket({ state: state(), ...io }),
        /LOAD_BUCKET_REQUIRES_EMPTY_STORE/u
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
        await assert.rejects(initializeLoadBucket({ state: state(), ...io }));
        assert.equal(io.proofs.length, 0);
    }
});
test('a failed checkpoint cannot produce a returned successful setup proof', async () => {
    const io = adapters();
    await assert.rejects(
        initializeLoadBucket({
            state: state(),
            ...io,
            checkpoint: async () => {
                throw new Error('SYNTHETIC_CHECKPOINT_REFUSAL');
            },
        }),
        /SYNTHETIC_CHECKPOINT_REFUSAL/u
    );
});

test('light bucket namespace cannot reuse default resources or guard receipts', async () => {
    const policy = getLoadPolicy('LIGHT_V1'),
        light = state();
    Object.assign(light, {
        namespace: policy.namespace,
        prefix: policy.namespace + '-' + run,
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        loadPolicy: structuredClone(policy.loadPolicy),
    });
    light.environment.VECTORIX_DEFAULT_S3_BUCKET =
        policy.emailPrefix + '-' + run;
    light.environment.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID =
        policy.emailPrefix + '-' + run;
    validateBucketState(light, run);
    const value = {
        schemaVersion: 1,
        namespace: policy.namespace,
        runId: run,
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        purpose: 'bucket',
        resourceOwnership: true,
        databaseReadOnly: true,
        bootstrapFreshness: true,
    };
    validateBucketGuard(value, run, policy);
    assert.throws(() => validateBucketGuard(value, run, defaultPolicy));
    assert.throws(() =>
        validateBucketState(
            { ...light, namespace: defaultPolicy.namespace },
            run
        )
    );
    assert.throws(() =>
        validateBucketState(
            {
                ...light,
                environment: {
                    ...light.environment,
                    VECTORIX_DEFAULT_S3_BUCKET: 'm7c-load-' + run,
                },
            },
            run
        )
    );
});
