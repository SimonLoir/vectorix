/** Closed experiment/collection-role bindings. Import performs no I/O and never selects policy from a caller path. */
import {
    getLoadPolicy,
    loadPolicySha256,
    profileForCollectionRole,
    assertCollectionRoleOrganization,
} from './load-policy-registry.mjs';
import {
    need,
    observationPolicy,
    LoadObservationError,
} from './load-observer-core.mjs';
import path from 'node:path';

/** Before reading state, permit only the two exact namespace/run paths; full state identity is checked after the read. */
export function observationStateLocation(root, statePath, runId) {
    need(
        typeof root === 'string' &&
            path.isAbsolute(root) &&
            typeof runId === 'string' &&
            /^[a-f0-9]{12}$/u.test(runId),
        'LOAD_OBS_SCOPE'
    );
    const matches = ['DEFAULT_V1', 'LIGHT_V1']
        .map(getLoadPolicy)
        .filter(
            (policy) =>
                statePath ===
                path.join(
                    root,
                    'node_modules/.cache/vectorix',
                    policy.namespace + '-' + runId,
                    'state.json'
                )
        );
    need(matches.length === 1, 'LOAD_OBS_POLICY_BINDING');
    return {
        policy: matches[0],
        directory: path.dirname(statePath),
    };
}

/** Every newly prepared default or light observation requires both bindings; legacy captures are never adopted. */
export function observationBinding(state, fixture, input) {
    const policy = observationPolicy(state),
        policySha256 = loadPolicySha256(policy);
    need(input?.policySha256 === policySha256, 'LOAD_OBS_POLICY_BINDING');
    try {
        assertCollectionRoleOrganization(
            policy,
            input.collectionRole,
            input.organizationId,
            fixture
        );
    } catch {
        throw new LoadObservationError('LOAD_OBS_POLICY_BINDING');
    }
    return { collectionRole: input.collectionRole, policySha256 };
}

/** A receipt's exact policy/role must survive every immutable baseline and final-proof replay check. */
export function assertObservationBinding(record, expected) {
    need(
        expected &&
            record?.collectionRole === expected.collectionRole &&
            record.policySha256 === expected.policySha256,
        'LOAD_OBS_POLICY_BINDING'
    );
}

/** Primary/pilot and reference/ingestion profiles are selected by captured roles, never organization/cardinality heuristics. */
export function observationProfile(
    state,
    fixture,
    input,
    referenceMetadataFields
) {
    observationBinding(state, fixture, input);
    try {
        return profileForCollectionRole(
            observationPolicy(state),
            input.collectionRole,
            input.collectionRole === 'referenceB'
                ? referenceMetadataFields
                : undefined
        );
    } catch {
        throw new LoadObservationError('LOAD_OBS_POLICY_BINDING');
    }
}

/** Traffic ingestion is always the unchanged control profile, including organization A in the light experiment. */
export function ingestionProfile(state, fixture, input) {
    need(
        ['ingestionA', 'ingestionB'].includes(input?.collectionRole),
        'LOAD_OBS_POLICY_BINDING'
    );
    return observationProfile(state, fixture, input);
}
