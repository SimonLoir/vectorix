/** Pure registry tests only: no SDK, filesystem client or runtime side effect. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getLoadPolicy,
    loadPolicyForState,
    policySha256,
    profileForCollectionRole,
    assertCollectionRoleOrganization,
} from './load-policy-registry.mjs';
const state = (id) => {
    const p = getLoadPolicy(id);
    return {
        experimentPolicyId: p.id,
        experimentPolicySha256: policySha256(p),
        namespace: p.namespace,
        loadPolicy: structuredClone(p.loadPolicy),
    };
};
test('closed immutable registry preserves the default and binds the new light identity', () => {
    const d = getLoadPolicy('DEFAULT_V1'),
        l = getLoadPolicy('LIGHT_V1');
    assert.equal(d.namespace, 'vectorix-m7c-load');
    assert.equal(
        d.identity.family,
        '4f64a77bb49dc1e547aa37fc438507bcfee2a894697424357eb61f4f47bedbfb'
    );
    assert.equal(l.namespace, 'vectorix-m7c-light-load');
    assert.notEqual(policySha256(d), policySha256(l));
    for (const p of [d, l]) {
        assert.equal(p.loadPolicy.fullSeconds, 7200);
        assert.equal(p.loadPolicy.maximumDocuments, 240);
        assert.equal(p.loadPolicy.maximumCollections, 20);
        assert.equal(p.identity.weights, d.identity.weights);
        assert.equal(p.controlChunking.parentMaxTokens, 2048);
        assert.equal(p.identity.reference, d.identity.reference);
    }
    assert.throws(() => {
        l.primaryChunking.maxTokens = 999;
    });
    for (const id of ['', null, 'LIGHT', 'native-light-load-v1', '__proto__'])
        assert.throws(() => getLoadPolicy(id));
});
test('both experiments require exact state binding without historical fallback', () => {
    for (const id of ['DEFAULT_V1', 'LIGHT_V1']) {
        const s = state(id);
        assert.equal(loadPolicyForState(s).id, id);
        for (const alter of [
            (x) => delete x.experimentPolicyId,
            (x) => delete x.experimentPolicySha256,
            (x) => (x.namespace = 'vectorix-unknown'),
            (x) => (x.loadPolicy.fullSeconds = 7201),
            (x) => (x.loadPolicy.profile.targetTokens = 256),
            (x) =>
                (x.experimentPolicyId =
                    id === 'LIGHT_V1' ? 'DEFAULT_V1' : 'LIGHT_V1'),
        ]) {
            const bad = structuredClone(s);
            alter(bad);
            assert.throws(() => loadPolicyForState(bad));
        }
    }
    assert.throws(() =>
        policySha256({
            ...getLoadPolicy('LIGHT_V1'),
            controlChunking: {
                ...getLoadPolicy('LIGHT_V1').controlChunking,
                maxTokens: 192,
            },
        })
    );
});
test('five explicit collection roles retain default controls and have no unknown fallback', () => {
    for (const id of ['DEFAULT_V1', 'LIGHT_V1'])
        for (const role of [
            'pilotA',
            'primaryA',
            'referenceB',
            'ingestionA',
            'ingestionB',
        ]) {
            const profile = profileForCollectionRole(getLoadPolicy(id), role, {
                    typed: 'NUMBER',
                }),
                primary = ['pilotA', 'primaryA'].includes(role),
                light = id === 'LIGHT_V1' && primary;
            assert.equal(profile.chunking.targetTokens, light ? 128 : 512);
            assert.equal(profile.chunking.parentMaxTokens, light ? 512 : 2048);
            assert.equal(profile.dimensions, 768);
            assert.equal(profile.preparation, '');
            assert.deepEqual(profile.metadataFields, { typed: 'NUMBER' });
        }
    for (const role of [undefined, 'owner', 'primary', 'ReferenceB'])
        assert.throws(() =>
            profileForCollectionRole(getLoadPolicy('LIGHT_V1'), role)
        );
});
test('collection organization roles are bound to actual owner/foreign, never array order', () => {
    const p = getLoadPolicy('LIGHT_V1'),
        fixture = {
            organizationIds: ['org-b', 'org-a'],
            users: {
                owner: { organizationId: 'org-a' },
                foreign: { organizationId: 'org-b' },
            },
        };
    for (const role of ['pilotA', 'primaryA', 'ingestionA']) {
        assert.equal(
            assertCollectionRoleOrganization(p, role, 'org-a', fixture),
            'org-a'
        );
        assert.throws(() =>
            assertCollectionRoleOrganization(p, role, 'org-b', fixture)
        );
    }
    for (const role of ['referenceB', 'ingestionB'])
        assert.equal(
            assertCollectionRoleOrganization(p, role, 'org-b', fixture),
            'org-b'
        );
    assert.throws(() =>
        assertCollectionRoleOrganization(p, 'primaryA', 'org-a', {
            organizationIds: ['org-a', 'org-b'],
        })
    );
});
