/** Closed profile and immutable receipt mocks only; no runtime, HTTP, database, model or process action. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getLoadPolicy, loadPolicySha256 } from './load-policy-registry.mjs';
import {
    validateIdentity,
    digest,
    observationPolicy,
    LoadObservationError,
} from './load-observer-core.mjs';
import { createLoadObserver } from './load-observer.mjs';
import {
    observationBinding,
    observationProfile,
    ingestionProfile,
    assertObservationBinding,
    observationStateLocation,
} from './load-observer-policy.mjs';
import {
    observationFixture,
    roleFields,
} from './load-observer.test-helper.mjs';

const roles = ['pilotA', 'primaryA', 'referenceB', 'ingestionA', 'ingestionB'];
const values = (profile) =>
    [
        'targetTokens',
        'minTokens',
        'maxTokens',
        'overlapTokens',
        'parentMaxTokens',
    ].map((name) => profile.chunking[name]);

test('default keeps all five legacy numerical profiles while light changes only A pilot and primary', () => {
    for (const id of ['DEFAULT_V1', 'LIGHT_V1']) {
        const { state, fixture } = observationFixture(id);
        validateIdentity(state, fixture);
        for (const role of roles) {
            const organizationId = ['referenceB', 'ingestionB'].includes(role)
                ? 'orgB'
                : 'orgA';
            const input = { ...roleFields(role, id), organizationId };
            const profile = observationProfile(state, fixture, input, {
                reference: 'STRING',
            });
            assert.deepEqual(
                values(profile),
                id === 'LIGHT_V1' && ['pilotA', 'primaryA'].includes(role)
                    ? [128, 32, 192, 16, 512]
                    : [512, 128, 768, 64, 2048]
            );
            assert.equal(profile.dimensions, 768);
            assert.equal(profile.preparation, '');
            assert.equal(profile.embeddingPreset, 'EMBEDDING_GEMMA');
            if (role === 'referenceB')
                assert.deepEqual(profile.metadataFields, {
                    reference: 'STRING',
                });
            if (role.startsWith('ingestion'))
                assert.deepEqual(
                    values(ingestionProfile(state, fixture, input)),
                    [512, 128, 768, 64, 2048]
                );
        }
    }
});

test('both experiments require exact current state/policy and cannot adopt historical unbound metadata', () => {
    for (const id of ['DEFAULT_V1', 'LIGHT_V1']) {
        const { state, fixture } = observationFixture(id),
            input = { ...roleFields('primaryA', id), organizationId: 'orgA' };
        for (const field of ['collectionRole', 'policySha256']) {
            const missing = { ...input };
            delete missing[field];
            assert.throws(() => observationBinding(state, fixture, missing));
        }
        for (const mutate of [
            (s) => {
                delete s.experimentPolicyId;
            },
            (s) => {
                s.experimentPolicyId = 'UNKNOWN';
            },
            (s) => {
                s.experimentPolicySha256 = '0'.repeat(64);
            },
            (s) => {
                s.namespace = 'vectorix-m7c-quality';
            },
            (s) => {
                s.loadPolicy.profile.targetTokens = 1;
            },
        ]) {
            const invalid = structuredClone(state);
            mutate(invalid);
            assert.throws(() => validateIdentity(invalid, fixture));
        }
    }
});

test('role and receipt bindings reject cross-policy, cross-tenant, unknown role and A-primary-as-ingestion', () => {
    const { state, fixture } = observationFixture('LIGHT_V1'),
        input = {
            ...roleFields('primaryA', 'LIGHT_V1'),
            organizationId: 'orgA',
        },
        binding = observationBinding(state, fixture, input);
    assertObservationBinding({ ...binding }, binding);
    for (const bad of [
        { ...input, collectionRole: 'arbitrary' },
        { ...input, organizationId: 'orgB' },
        { ...input, ...roleFields('primaryA', 'DEFAULT_V1') },
    ])
        assert.throws(() => observationBinding(state, fixture, bad));
    for (const bad of [
        {},
        roleFields('primaryA'),
        roleFields('ingestionA', 'LIGHT_V1'),
    ])
        assert.throws(() => assertObservationBinding(bad, binding));
    assert.throws(() => ingestionProfile(state, fixture, input));
    const reversed = { ...fixture, organizationIds: ['orgB', 'orgA'] };
    assert.deepEqual(observationBinding(state, reversed, input), binding);
});

test('unknown or missing new binding refuses before any reader, admission or receipt writer', async () => {
    const { state, fixture } = observationFixture('LIGHT_V1');
    let calls = 0;
    const touched = () => {
        calls++;
        throw Error('unexpected capability');
    };
    const observer = createLoadObserver({
        state,
        fixture,
        admit: touched,
        reader: { native: touched, generation: touched },
        store: { read: touched, write: touched },
        now: () => 0,
        sleep: touched,
    });
    const input = {
        runId: state.runId,
        organizationId: 'orgA',
        collectionId: 'collection',
        ...roleFields('primaryA', 'LIGHT_V1'),
    };
    for (const fields of [
        { collectionRole: undefined },
        { policySha256: undefined },
        { collectionRole: 'unknown' },
        { organizationId: 'orgB' },
    ])
        await assert.rejects(() =>
            observer.beginIndexObservation({ ...input, ...fields })
        );
    assert.equal(calls, 0);
});

test('state-path pre-read admission permits only the two exact namespace/run paths', () => {
    const root = '/synthetic/workspace',
        run = '0123456789ab';
    for (const id of ['DEFAULT_V1', 'LIGHT_V1']) {
        const policy = getLoadPolicy(id),
            dir = `${root}/node_modules/.cache/vectorix/${policy.namespace}-${run}`;
        assert.equal(
            observationStateLocation(root, dir + '/state.json', run).policy.id,
            id
        );
    }
    for (const invalid of [
        `${root}/.env`,
        `${root}/node_modules/.cache/vectorix/vectorix-m7c-light-load-${run}/../state.json`,
        `${root}/node_modules/.cache/vectorix/vectorix-m7c-unknown-${run}/state.json`,
    ])
        assert.throws(() => observationStateLocation(root, invalid, run));
    assert.notEqual(
        loadPolicySha256(getLoadPolicy('DEFAULT_V1')),
        loadPolicySha256(getLoadPolicy('LIGHT_V1'))
    );
});

test('an otherwise matching saved baseline cannot cross roles or policies before generation/native reads', async () => {
    const { state, fixture } = observationFixture('LIGHT_V1'),
        binding = roleFields('primaryA', 'LIGHT_V1'),
        snapshot = { producerIdentitySha256: 'b'.repeat(64) },
        baselineSha256 = digest(snapshot),
        input = {
            ...binding,
            runId: state.runId,
            organizationId: 'orgA',
            collectionId: 'collection',
            generationId: 'generation',
            bindings: [],
            descriptors: [],
            nativeBaseline: {
                ...binding,
                runId: state.runId,
                organizationId: 'orgA',
                collectionId: 'collection',
                baselineSha256,
                producerIdentitySha256: snapshot.producerIdentitySha256,
            },
        },
        saved = {
            ...binding,
            kind: 'LOAD_NATIVE_BASELINE_RECORD',
            runId: state.runId,
            organizationId: 'orgA',
            collectionId: 'collection',
            snapshot,
        };
    for (const wrong of [
        roleFields('ingestionA', 'LIGHT_V1'),
        roleFields('primaryA', 'DEFAULT_V1'),
        { collectionRole: undefined, policySha256: undefined },
    ]) {
        let reads = 0;
        const forbidden = () => {
            reads++;
            throw Error('unexpected reader');
        };
        const observer = createLoadObserver({
            state,
            fixture,
            admit: async () => {},
            reader: { native: forbidden, generation: forbidden },
            store: {
                read: async () => ({ ...saved, ...wrong }),
                write: forbidden,
            },
            now: () => 0,
            sleep: forbidden,
        });
        await assert.rejects(
            () => observer.observeGeneration(input),
            /LOAD_OBS_POLICY_BINDING/u
        );
        assert.equal(reads, 0);
    }
});

test('malformed pre-I/O scope and unknown policies preserve finite typed observer errors', async () => {
    const { state, fixture } = observationFixture('LIGHT_V1');
    const typed = (code) => (error) =>
        error instanceof LoadObservationError &&
        error.code === code &&
        error.message === code;
    for (const invalid of [
        null,
        undefined,
        [],
        {},
        { ...state, runId: undefined },
    ])
        assert.throws(
            () => validateIdentity(invalid, fixture),
            typed('LOAD_OBS_SCOPE')
        );
    assert.throws(() => validateIdentity(state, null), typed('LOAD_OBS_SCOPE'));
    for (const invalid of [
        { ...state, experimentPolicyId: 'UNKNOWN' },
        { ...state, experimentPolicySha256: '0'.repeat(64) },
        { ...state, loadPolicy: {} },
    ]) {
        assert.throws(
            () => validateIdentity(invalid, fixture),
            typed('LOAD_OBS_POLICY_BINDING')
        );
        assert.throws(
            () => observationPolicy(invalid),
            typed('LOAD_OBS_POLICY_BINDING')
        );
    }
    assert.throws(
        () =>
            observationBinding(state, fixture, {
                ...roleFields('primaryA', 'LIGHT_V1'),
                collectionRole: 'UNKNOWN',
                organizationId: 'orgA',
            }),
        typed('LOAD_OBS_POLICY_BINDING')
    );
    assert.throws(
        () => observationStateLocation(null, null, null),
        typed('LOAD_OBS_SCOPE')
    );
    let capabilities = 0;
    const touched = () => {
        capabilities++;
        throw Error('unexpected capability');
    };
    assert.throws(
        () =>
            createLoadObserver({
                state: { ...state, experimentPolicyId: 'UNKNOWN' },
                fixture,
                admit: touched,
                reader: { native: touched, generation: touched },
                store: { read: touched, write: touched },
                now: touched,
                sleep: touched,
            }),
        typed('LOAD_OBS_POLICY_BINDING')
    );
    assert.equal(capabilities, 0);
});
