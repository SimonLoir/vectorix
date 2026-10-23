/** Closed experiment registry. Importing performs no I/O and accepts no executable configuration. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const need = (value) => {
    if (!value) throw Error('LOAD_EXPERIMENT_POLICY');
};
const freeze = (value) => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};
const canonical = (value) =>
    Array.isArray(value)
        ? '[' + value.map(canonical).join(',') + ']'
        : value && typeof value === 'object'
          ? '{' +
            Object.keys(value)
                .sort()
                .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
                .join(',') +
            '}'
          : JSON.stringify(value);
const REGISTRY = freeze({
    DEFAULT_V1: {
        id: 'DEFAULT_V1',
        policyVersion: 'native-default-load-v1',
        namespace: 'vectorix-m7c-load',
        version: 'm7c-load-v1',
        identity: {
            family: '4f64a77bb49dc1e547aa37fc438507bcfee2a894697424357eb61f4f47bedbfb',
            pilot: '0d008fd0514aac362e888aa6a582daef1cd0b3feb4cf26e6a3d096faaee0627c',
            full: 'c99db8842d4ab7a52457c8e81926389f7d66b49d569db026ed548fe841f01a67',
            reference:
                'cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc',
            weights:
                '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
        },
        documentIdPrefix: 'm7c-load-v1-d',
        documentBytes: 672192,
        corpusRoot: 'load-v1',
        minimumContextTokens: { primary: 1608, control: 1608 },
        primaryChunking: {
            targetTokens: 512,
            minTokens: 128,
            maxTokens: 768,
            overlapTokens: 64,
            semanticPercentile: 90,
            parentMaxTokens: 2048,
        },
        controlChunking: {
            targetTokens: 512,
            minTokens: 128,
            maxTokens: 768,
            overlapTokens: 64,
            semanticPercentile: 90,
            parentMaxTokens: 2048,
        },
        emailPrefix: 'm7c-load',
        databasePrefix: 'vectorix_m7c_load',
        label: 'vectorix.load-test',
        loadPolicy: {
            version: 'native-default-load-v1',
            maximumDocuments: 240,
            maximumCollections: 20,
            primaryDocuments: 200,
            referenceDocuments: 24,
            concurrentDocuments: 12,
            pilotDocuments: 4,
            pilotChildren: 2000,
            fullChildren: 100000,
            familySha256:
                '4f64a77bb49dc1e547aa37fc438507bcfee2a894697424357eb61f4f47bedbfb',
            pilotCorpusSha256:
                '0d008fd0514aac362e888aa6a582daef1cd0b3feb4cf26e6a3d096faaee0627c',
            fullCorpusSha256:
                'c99db8842d4ab7a52457c8e81926389f7d66b49d569db026ed548fe841f01a67',
            model: {
                provider: 'OLLAMA',
                model: 'embeddinggemma:latest',
                dimensions: 768,
                preset: 'EMBEDDING_GEMMA',
                digest: '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
            },
            profile: {
                strategy: 'TOKEN_WINDOW',
                targetTokens: 512,
                minTokens: 128,
                maxTokens: 768,
                overlapTokens: 64,
                parentMaxTokens: 2048,
                parentChild: true,
                preparation: '',
                indexType: 'DISKANN',
            },
            pilotSeconds: 1200,
            fullSeconds: 7200,
            phaseSeconds: 180,
            phaseDrainSeconds: 300,
            minimumFreeBytes: 4294967296,
            resourceSampling: {
                minimumIntervalMs: 1000,
                maximumSamples: 20000,
                maximumBytes: 33554432,
            },
            gracefulStopSeconds: 300,
        },
    },
    LIGHT_V1: {
        id: 'LIGHT_V1',
        policyVersion: 'native-light-load-v1',
        namespace: 'vectorix-m7c-light-load',
        version: 'm7c-light-v1',
        identity: {
            family: '66b2c83297a39f7e805ec5cf1fad2bc30297a0610570b8d06a6090285d8913d0',
            pilot: '14dd2e0bdcf31e55bff8c0ce6d018bdd42a42d12482c804cd1c9813a44b5d577',
            full: '5a6d27a0ffdf1acf558f327f3197257e7dcc9216e4717cd70d26de825138f0f2',
            reference:
                'cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc',
            weights:
                '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
        },
        documentIdPrefix: 'm7c-light-v1-d',
        documentBytes: 168048,
        corpusRoot: 'light-v1',
        minimumContextTokens: { primary: 457, control: 1608 },
        primaryChunking: {
            targetTokens: 128,
            minTokens: 32,
            maxTokens: 192,
            overlapTokens: 16,
            semanticPercentile: 90,
            parentMaxTokens: 512,
        },
        controlChunking: {
            targetTokens: 512,
            minTokens: 128,
            maxTokens: 768,
            overlapTokens: 64,
            semanticPercentile: 90,
            parentMaxTokens: 2048,
        },
        emailPrefix: 'm7c-light-load',
        databasePrefix: 'vectorix_m7c_light_load',
        label: 'vectorix.light-load-test',
        loadPolicy: {
            version: 'native-light-load-v1',
            maximumDocuments: 240,
            maximumCollections: 20,
            primaryDocuments: 200,
            referenceDocuments: 24,
            concurrentDocuments: 12,
            pilotDocuments: 4,
            pilotChildren: 2000,
            fullChildren: 100000,
            familySha256:
                '66b2c83297a39f7e805ec5cf1fad2bc30297a0610570b8d06a6090285d8913d0',
            pilotCorpusSha256:
                '14dd2e0bdcf31e55bff8c0ce6d018bdd42a42d12482c804cd1c9813a44b5d577',
            fullCorpusSha256:
                '5a6d27a0ffdf1acf558f327f3197257e7dcc9216e4717cd70d26de825138f0f2',
            model: {
                provider: 'OLLAMA',
                model: 'embeddinggemma:latest',
                dimensions: 768,
                preset: 'EMBEDDING_GEMMA',
                digest: '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
            },
            profile: {
                strategy: 'TOKEN_WINDOW',
                targetTokens: 128,
                minTokens: 32,
                maxTokens: 192,
                overlapTokens: 16,
                parentMaxTokens: 512,
                parentChild: true,
                preparation: '',
                indexType: 'DISKANN',
            },
            pilotSeconds: 1200,
            fullSeconds: 7200,
            phaseSeconds: 180,
            phaseDrainSeconds: 300,
            minimumFreeBytes: 4294967296,
            resourceSampling: {
                minimumIntervalMs: 1000,
                maximumSamples: 20000,
                maximumBytes: 33554432,
            },
            gracefulStopSeconds: 300,
        },
    },
});
export const COLLECTION_ROLES = Object.freeze([
    'pilotA',
    'primaryA',
    'referenceB',
    'ingestionA',
    'ingestionB',
]);
/** Select only one of the two reviewed immutable experiment descriptors. */
export function getLoadPolicy(id) {
    need(typeof id === 'string' && Object.hasOwn(REGISTRY, id));
    return REGISTRY[id];
}
/** Bind the full descriptor, including controls, identities and unchanged finite gates. */
export function policySha256(policy) {
    need(policy && isDeepStrictEqual(policy, REGISTRY[policy.id]));
    return createHash('sha256').update(canonical(policy)).digest('hex');
}
export const loadPolicySha256 = policySha256;
/** New runs require exact explicit identity; historical artifacts are never auto-adopted. */
export function loadPolicyForState(state) {
    need(state && typeof state === 'object');
    const policy = getLoadPolicy(state.experimentPolicyId);
    need(
        state.experimentPolicySha256 === policySha256(policy) &&
            state.namespace === policy.namespace &&
            isDeepStrictEqual(state.loadPolicy, policy.loadPolicy)
    );
    return policy;
}
/** Collection roles are distinct from owner/reader authentication roles. */
export function profileForCollectionRole(
    policy,
    role,
    metadataFields = {
        topic: 'STRING',
        document_no: 'NUMBER',
        active: 'BOOLEAN',
        dataset: 'STRING',
    }
) {
    policySha256(policy);
    need(COLLECTION_ROLES.includes(role));
    return {
        provider: 'OLLAMA',
        model: 'embeddinggemma:latest',
        dimensions: 768,
        metric: 'cosine',
        indexType: 'DISKANN',
        numericType: 'float32',
        preparation: '',
        embeddingPreset: 'EMBEDDING_GEMMA',
        metadataFields: structuredClone(metadataFields),
        chunkingStrategy: 'TOKEN_WINDOW',
        parentChild: true,
        chunking: structuredClone(
            ['pilotA', 'primaryA'].includes(role)
                ? policy.primaryChunking
                : policy.controlChunking
        ),
    };
}
export function assertCollectionRoleOrganization(
    policy,
    role,
    organizationId,
    fixture
) {
    policySha256(policy);
    need(
        COLLECTION_ROLES.includes(role) &&
            fixture?.organizationIds?.length === 2 &&
            fixture.organizationIds[0] !== fixture.organizationIds[1] &&
            fixture.users?.owner?.organizationId &&
            fixture.users?.foreign?.organizationId &&
            fixture.users.owner.organizationId !==
                fixture.users.foreign.organizationId &&
            fixture.organizationIds.includes(
                fixture.users.owner.organizationId
            ) &&
            fixture.organizationIds.includes(
                fixture.users.foreign.organizationId
            ) &&
            organizationId ===
                fixture.users[
                    ['referenceB', 'ingestionB'].includes(role)
                        ? 'foreign'
                        : 'owner'
                ].organizationId
    );
    return organizationId;
}
