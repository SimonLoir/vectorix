/** Synthetic experiment fixtures only. No file, credential, network or resource operation. */
import { getLoadPolicy, loadPolicySha256 } from './load-policy-registry.mjs';

export function experimentFields(id = 'DEFAULT_V1') {
    const policy = getLoadPolicy(id);
    return {
        experimentPolicyId: policy.id,
        experimentPolicySha256: loadPolicySha256(policy),
        loadPolicy: structuredClone(policy.loadPolicy),
    };
}

export function roleFields(role, id = 'DEFAULT_V1') {
    const policy = getLoadPolicy(id);
    return { collectionRole: role, policySha256: loadPolicySha256(policy) };
}

export function fixturePolicyFields(id = 'DEFAULT_V1') {
    const policy = getLoadPolicy(id);
    return {
        experimentPolicyId: policy.id,
        experimentPolicySha256: loadPolicySha256(policy),
    };
}

export function observationFixture(id = 'DEFAULT_V1') {
    const policy = getLoadPolicy(id),
        runId = '0123456789ab',
        applicationDatabase = `${policy.databasePrefix}_app_${runId}_test`,
        vectorDatabase = `${policy.databasePrefix}_vectors_${runId}_test`;
    return {
        state: {
            schemaVersion: 1,
            namespace: policy.namespace,
            prefix: policy.namespace + '-' + runId,
            runId,
            ...experimentFields(id),
            applicationDatabase,
            vectorDatabase,
            ports: { postgres: 15432, vector: 15433 },
            environment: {
                DATABASE_URL: `postgresql://postgres:synthetic@127.0.0.1:15432/${applicationDatabase}`,
                VECTOR_DATABASE_URL: `postgresql://runtime:synthetic@127.0.0.1:15433/${vectorDatabase}`,
            },
        },
        fixture: {
            schemaVersion: 1,
            ...fixturePolicyFields(id),
            namespace: policy.namespace,
            runId,
            organizationIds: ['orgA', 'orgB'],
            users: {
                owner: { userId: 'owner', organizationId: 'orgA' },
                reader: { userId: 'reader', organizationId: 'orgA' },
                foreign: { userId: 'foreign', organizationId: 'orgB' },
            },
        },
    };
}
