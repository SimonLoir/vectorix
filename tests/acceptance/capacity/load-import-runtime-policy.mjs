/** Pure load-runtime identity, finite-result and receipt validation. No I/O on import. */
import path from 'node:path';
import {
    validateLoadTransportState,
    LoadTransportError,
} from './load-transport.mjs';
import {
    validateIdentity,
    digest,
    LoadObservationError,
} from './load-observer-core.mjs';
import { sizeBindings, SIZE_LIMITS, LoadSizeError } from './load-sizes.mjs';
import { sha, same, LoadImportError } from './load-import-core.mjs';
import { loadPolicyForState, policySha256 } from './load-policy-registry.mjs';
export const LOAD_RUNTIME_HELPERS = Object.freeze([
    'load-topology.py',
    'load_topology_policy.py',
    'load-policy-registry.mjs',
    'load_policy_registry.py',
    'load-light-policy.mjs',
    'load-light-corpus.mjs',
    'load-import-runtime.mjs',
    'load-import-runtime-content.mjs',
    'load-import-runtime-policy.mjs',
    'load-import-runtime-files.mjs',
    'load-import-runtime-services.mjs',
    'load-private.mjs',
    'load-transport.mjs',
    'load-import-protocol.mjs',
    'load-import-core.mjs',
    'load-import-documents.mjs',
    'load-import-collections.mjs',
    'load-corpus.mjs',
    'load-observer.mjs',
    'load-observer-policy.mjs',
    'load-observer-core.mjs',
    'load-observer-layout.mjs',
    'load-observer-sql.mjs',
    'load-observer-runtime.mjs',
    'load-resources.mjs',
    'load-resources-runtime.mjs',
    'load-sizes.mjs',
    'load-sizes-runtime.mjs',
]);
export const RUNTIME_LIMITS = Object.freeze({
    stateBytes: 128 * 1024,
    fixtureBytes: 128 * 1024,
    journalBytes: 512 * 1024,
    reportBytes: 8 * 1024 ** 2,
});
const SAFE = new Set([
    'LOAD_RUNTIME_DISABLED',
    'LOAD_RUNTIME_ARGUMENTS',
    'LOAD_RUNTIME_CONTEXT',
    'LOAD_RUNTIME_GUARD',
    'LOAD_RUNTIME_PRIVATE',
    'LOAD_RUNTIME_PRIOR_PROGRESS',
    'LOAD_RUNTIME_CONTENT',
    'LOAD_RUNTIME_ADAPTER',
    'LOAD_RUNTIME_REPORT',
    'LOAD_RUNTIME_PILOT_GATE',
    'LOAD_RUNTIME_RESOURCE_UNSAFE',
    'LOAD_RUNTIME_IMPORT_FAILED',
    'LOAD_RUNTIME_SERVICES_REFUSED',
    'LOAD_RUNTIME_CLOSE_FAILED',
    'LOAD_RUNTIME_SIZE_PROOF',
]);
export class LoadRuntimeError extends Error {
    constructor(
        code = 'LOAD_RUNTIME_IMPORT_FAILED',
        acceptance = 'NOT_APPLICABLE'
    ) {
        super(SAFE.has(code) ? code : 'LOAD_RUNTIME_IMPORT_FAILED');
        this.code = this.message;
        this.acceptance = ['NOT_SENT', 'UNKNOWN', 'NOT_APPLICABLE'].includes(
            acceptance
        )
            ? acceptance
            : 'UNKNOWN';
    }
}
export const need = (value, code) => {
    if (!value) throw new LoadRuntimeError(code);
};
export const hash = (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
/** Closed orchestration boundaries only; no operation, identifier, URL or exception message is included. */
export const LOAD_FAILURE_STAGES = Object.freeze([
    'UNSPECIFIED',
    'PREFLIGHT',
    'CREATE_SERVICES',
    'AUTHENTICATE',
    'PREPARE_BASELINE',
    'WRITE_BASELINE_REPORT',
    'MEASURE_BEFORE',
    'IMPORT_PILOT',
    'IMPORT_FULL',
    'MEASURE_AFTER',
    'FINAL_GUARD',
    'CLOSE_SERVICES',
    'WRITE_REPORT',
    'WRITE_OUTCOME',
]);
const KNOWN_ADAPTER_CODES = new Set(
    `
    LOAD_ACTIVE_STATUS LOAD_ACTUAL_HTTP_PROOF LOAD_ASSOCIATION_COUNT LOAD_ASSOCIATION_INPUT
    LOAD_ASSOCIATION_RESPONSE LOAD_AUTH LOAD_AUTH_IDENTITY LOAD_BASELINE_CHANGED LOAD_BUDGET
    LOAD_CALL_CAP LOAD_CANCELLED LOAD_CANONICAL_HASH LOAD_CANONICAL_PAGE
    LOAD_CLOCK_NOT_ADVANCED LOAD_CONCURRENCY LOAD_CONFIG LOAD_COOKIE LOAD_DOCUMENT_CHANGED
    LOAD_DOCUMENT_INPUT LOAD_EXISTING_BINDING LOAD_EXPERIMENT_POLICY LOAD_EXTRACTION_FAILED LOAD_FORBIDDEN
    LOAD_FROZEN_CORPUS LOAD_GENERATION_BINDING LOAD_HTTP LOAD_IMPORT_CONFIG
    LOAD_IMPORT_DEADLINE LOAD_IMPORT_FAILED LOAD_INDEPENDENT_PROOF LOAD_INDEX_ACCESS
    LOAD_INDEX_FAILED LOAD_INPUT_CAP LOAD_INVENTORY_CAP LOAD_INVENTORY_CHANGED
    LOAD_JOURNAL_CAP LOAD_LOCAL_SOURCE_HASH LOAD_METADATA_CHANGED LOAD_METADATA_RESPONSE
    LOAD_MUTATION_CAP LOAD_NATIVE_BASELINE LOAD_NATIVE_BASELINE_RECORD LOAD_NATIVE_PROBE
    LOAD_NATIVE_WORK_PROOF LOAD_NATIVE_WORK_RECEIPT LOAD_NEW_GENERATION_REQUIRED
    LOAD_OBSERVATION_FAILED LOAD_OBSERVER LOAD_OBSERVER_REQUIRED LOAD_OBS_ACCOUNTING
    LOAD_OBS_ADAPTER LOAD_OBS_BASELINE LOAD_OBS_BOUNDS LOAD_OBS_CANONICAL_ADAPTER
    LOAD_OBS_CANONICAL_ROW LOAD_OBS_COUNTER LOAD_OBS_COUNTER_RESET LOAD_OBS_CURRENT
    LOAD_OBS_DATABASE LOAD_OBS_DATABASE_READ LOAD_OBS_DESTINATION LOAD_OBS_DOCUMENT_BOUND
    LOAD_OBS_EXCLUSIVITY LOAD_OBS_FROZEN_GEOMETRY LOAD_OBS_GAP LOAD_OBS_GENERATION
    LOAD_OBS_GUARD LOAD_OBS_HOUR_BOUND LOAD_OBS_HOUR_LOST LOAD_OBS_IDENTITY
    LOAD_OBS_LAYOUT_BOUND LOAD_OBS_MANIFEST LOAD_OBS_MARKER LOAD_OBS_NATIVE_COVERAGE
    LOAD_OBS_NATIVE_FAILURE LOAD_OBS_NATIVE_INPUT LOAD_OBS_NOT_DRAINED LOAD_OBS_NOT_STABLE
    LOAD_OBS_PAGE LOAD_OBS_PARENT LOAD_OBS_PHYSICAL_BOUND LOAD_OBS_PHYSICAL_ROW LOAD_OBS_POLICY_BINDING
    LOAD_OBS_PREPARED_INPUT LOAD_OBS_PRODUCER LOAD_OBS_PROFILE LOAD_OBS_PROGRESS
    LOAD_OBS_PUBLICATION LOAD_OBS_READ_DEADLINE LOAD_OBS_RECEIPT LOAD_OBS_RESOURCE_ADAPTER
    LOAD_OBS_RESOURCE_BYTES LOAD_OBS_RESOURCE_CGROUP LOAD_OBS_RESOURCE_CONTAINER
    LOAD_OBS_RESOURCE_COUNT LOAD_OBS_RESOURCE_DISK LOAD_OBS_RESOURCE_FILE
    LOAD_OBS_RESOURCE_FINISHED LOAD_OBS_RESOURCE_IDENTITY LOAD_OBS_RESOURCE_INTERVAL
    LOAD_OBS_RESOURCE_NUMBER LOAD_OBS_RESOURCE_PLATFORM LOAD_OBS_RESOURCE_PROCESS
    LOAD_OBS_RESOURCE_READ LOAD_OBS_RESOURCE_RESET LOAD_OBS_RESOURCE_SAMPLE
    LOAD_OBS_RESOURCE_SCOPE LOAD_OBS_RESOURCE_UNSAFE LOAD_OBS_ROW LOAD_OBS_RUNTIME_DISABLED
    LOAD_OBS_SCOPE LOAD_OBS_SOURCE LOAD_OBS_SOURCE_BOUND LOAD_OBS_TASK LOAD_OBS_VECTOR_LEDGER
    LOAD_OPERATION LOAD_ORIGINAL_BOUND LOAD_ORIGINAL_HASH LOAD_PARTIAL_REPLAY_REFUSED
    LOAD_PHASE_DEADLINE LOAD_PHYSICAL_COUNT LOAD_PILOT_ADMISSION LOAD_POLL_CAP
    LOAD_PREVIEW_PAGE_CAP LOAD_PRIOR_REPORT LOAD_PUBLICATION_PROOF LOAD_RATE
    LOAD_RATE_REJECTED LOAD_REDIRECT LOAD_REFERENCE_CORPUS LOAD_REQUEST_CAP
    LOAD_RESOURCE_POLICY LOAD_RESOURCE_PROOF LOAD_RESPONSE_CAP LOAD_RETRY_REFUSED LOAD_RPC
    LOAD_SAVED_PROFILE LOAD_SESSION_BUSY LOAD_SIZE_ADAPTER LOAD_SIZE_BINDING LOAD_SIZE_BYTES
    LOAD_SIZE_CLOCK LOAD_SIZE_DATABASE LOAD_SIZE_DEADLINE LOAD_SIZE_GUARD LOAD_SIZE_PATH
    LOAD_SIZE_PRODUCER LOAD_SIZE_REFUSED LOAD_SIZE_REPLAY LOAD_SIZE_RUNTIME_DISABLED
    LOAD_SIZE_SCOPE LOAD_TASK_HISTORY LOAD_TIMEOUT LOAD_TRANSPORT LOAD_UNAUTHORIZED
    LOAD_UNEXPECTED_INVENTORY LOAD_UNEXPECTED_LIBRARY LOAD_UPLOAD_BINDING
`
        .trim()
        .split(/\s+/u)
);
const ADAPTER_KINDS = new Set([
    'TRANSPORT',
    'OBSERVATION',
    'STORE_SIZE',
    'IMPORT',
    'RUNTIME',
    'UNKNOWN',
]);
const UNKNOWN_ADAPTER = Object.freeze({
    kind: 'UNKNOWN',
    code: null,
    status: null,
});
/** Accept only locally typed errors and fixed known codes. Never inspect message, cause, stack or arbitrary status. */
function adapterDiagnostic(error) {
    const kind =
        error instanceof LoadTransportError
            ? 'TRANSPORT'
            : error instanceof LoadObservationError
              ? 'OBSERVATION'
              : error instanceof LoadSizeError
                ? 'STORE_SIZE'
                : error instanceof LoadImportError
                  ? 'IMPORT'
                  : null;
    if (kind)
        return Object.freeze({
            kind,
            code: KNOWN_ADAPTER_CODES.has(error.code) ? error.code : null,
            status:
                error instanceof LoadTransportError &&
                Number.isInteger(error.status) &&
                error.status >= 100 &&
                error.status <= 599
                    ? error.status
                    : null,
        });
    if (error instanceof LoadRuntimeError) {
        const saved = error.adapter;
        if (saved && ADAPTER_KINDS.has(saved.kind))
            return Object.freeze({
                kind: saved.kind,
                code:
                    KNOWN_ADAPTER_CODES.has(saved.code) || SAFE.has(saved.code)
                        ? saved.code
                        : null,
                status:
                    saved.kind === 'TRANSPORT' &&
                    Number.isInteger(saved.status) &&
                    saved.status >= 100 &&
                    saved.status <= 599
                        ? saved.status
                        : null,
            });
        return Object.freeze({
            kind: 'RUNTIME',
            code: SAFE.has(error.code) ? error.code : null,
            status: null,
        });
    }
    return UNKNOWN_ADAPTER;
}
/** Add finite stage/adapter evidence without changing conservative mutation acceptance. Nested sanitization preserves it. */
export const safeFailure = (error, stage = 'UNSPECIFIED') => {
    const safe =
        error instanceof LoadRuntimeError
            ? error
            : new LoadRuntimeError(
                  'LOAD_RUNTIME_IMPORT_FAILED',
                  error?.acceptance === 'NOT_SENT' ? 'NOT_SENT' : 'UNKNOWN'
              );
    const savedStage =
        error instanceof LoadRuntimeError ? error.failureStage : null;
    safe.failureStage =
        LOAD_FAILURE_STAGES.includes(savedStage) && savedStage !== 'UNSPECIFIED'
            ? savedStage
            : LOAD_FAILURE_STAGES.includes(stage)
              ? stage
              : 'UNSPECIFIED';
    safe.adapter = adapterDiagnostic(error);
    return safe;
};
export const encoded = (value, maximum) => {
    const text = JSON.stringify(value);
    need(
        typeof text === 'string' && Buffer.byteLength(text) <= maximum,
        'LOAD_RUNTIME_PRIVATE'
    );
    return text;
};
/** Exact foreground arguments; no hostname/DSN, replay or draft bypass flag is accepted. */
export function parseLoadImportArgs(args) {
    need(
        Array.isArray(args) &&
            args.length === 6 &&
            args[0] === '--state' &&
            args[2] === '--run' &&
            args[4] === '--mode' &&
            typeof args[1] === 'string' &&
            /^[a-f0-9]{12}$/u.test(args[3]) &&
            ['pilot', 'full'].includes(args[5]),
        'LOAD_RUNTIME_ARGUMENTS'
    );
    return { statePath: args[1], runId: args[3], mode: args[5] };
}
/** The independent Python guard remains responsible for actual containers, pins, schema and parent-PID identity. */
export function validateLoadRuntimeContext(context) {
    const { state, fixture, root, helperDirectory, statePath, runId, mode } =
        context ?? {};
    need(
        typeof root === 'string' &&
            path.isAbsolute(root) &&
            helperDirectory === path.join(root, 'tests/acceptance/capacity') &&
            ['pilot', 'full'].includes(mode) &&
            runId === state?.runId,
        'LOAD_RUNTIME_CONTEXT'
    );
    validateLoadTransportState(state, fixture);
    const policy = loadPolicyForState(state);
    validateIdentity(state, fixture);
    need(
        LOAD_RUNTIME_HELPERS.every((name) =>
            hash(state.acceptanceSources?.[name])
        ),
        'LOAD_RUNTIME_CONTEXT'
    );
    const directory = path.join(
            root,
            'node_modules/.cache/vectorix',
            policy.namespace + '-' + runId
        ),
        caller = state.loadProcess;
    need(
        statePath === path.join(directory, 'state.json') &&
            state.phase === 'READY_FOR_LOAD_IMPORT' &&
            same(
                state.workflowHistory,
                mode === 'pilot' ? ['pilot'] : ['pilot', 'full']
            ) &&
            caller?.service === 'load' &&
            caller.workflow === mode &&
            caller.pid === process.pid &&
            caller.entry ===
                path.join(helperDirectory, 'load-import-runtime.mjs') &&
            caller.cwd === root &&
            hash(caller.entrySha256) &&
            caller.entrySha256 ===
                state.acceptanceSources?.['load-import-runtime.mjs'] &&
            typeof caller.startTicks === 'string' &&
            /^[0-9]{1,30}$/u.test(caller.startTicks) &&
            /^[a-f0-9-]{36}$/u.test(caller.bootId),
        'LOAD_RUNTIME_CONTEXT'
    );
    return { ...context, runDirectory: directory };
}
export function guardProof(proof, context) {
    need(
        proof &&
            Object.keys(proof).sort().join(',') ===
                'bootstrapFreshness,databaseReadOnly,experimentPolicyId,experimentPolicySha256,namespace,purpose,resourceOwnership,runId,schemaVersion' &&
            proof.schemaVersion === 1 &&
            proof.namespace === context.state.namespace &&
            proof.experimentPolicyId === context.state.experimentPolicyId &&
            proof.experimentPolicySha256 ===
                context.state.experimentPolicySha256 &&
            proof.runId === context.runId &&
            proof.purpose === 'import' &&
            proof.resourceOwnership === true &&
            proof.databaseReadOnly === true &&
            proof.bootstrapFreshness === false,
        'LOAD_RUNTIME_GUARD'
    );
}
export const pathsFor = (mode) => ({
    invocation: `load-${mode}-invocation.json`,
    journal: `load-${mode}-journal.json`,
    report: `load-${mode}-report.json`,
    outcome: `load-${mode}-outcome.json`,
});
export const CHILDREN = [
    'load-native-receipts',
    'load-resource-observations',
    'store-sizes',
];
export function checkReport(report, context, workflow, evidenceKind) {
    need(
        report?.schemaVersion === 1 &&
            report.namespace === context.state.namespace &&
            report.experimentPolicyId === context.state.experimentPolicyId &&
            report.policySha256 ===
                policySha256(loadPolicyForState(context.state)) &&
            report.runId === context.runId &&
            report.workflow === workflow &&
            report.status === 'COMPLETE' &&
            report.evidenceKind === evidenceKind &&
            report.capacityAcceptance === 'NOT_RUN' &&
            report.trafficAcceptance === 'NOT_RUN' &&
            report.acceptance ===
                (evidenceKind === 'SYNTHETIC_UNIT_TEST'
                    ? 'NOT_RUN'
                    : workflow === 'baseline'
                      ? 'BASELINE_PREPARED'
                      : workflow === 'pilot'
                        ? 'PILOT_PREPARED'
                        : 'FULL_INDEX_PREPARED'),
        'LOAD_RUNTIME_REPORT'
    );
    encoded(report, RUNTIME_LIMITS.reportBytes);
}
export function summaryFor(report) {
    return {
        schemaVersion: 1,
        completed: true,
        status: 'INDEX_PREPARATION_COMPLETE',
        runId: report.runId,
        experimentPolicyId: report.experimentPolicyId,
        policySha256: report.policySha256,
        workflow: report.workflow,
        evidenceKind: report.evidenceKind,
        acceptance: report.acceptance,
        capacityAcceptance: 'NOT_RUN',
        trafficAcceptance: 'NOT_RUN',
        reportSha256: sha(JSON.stringify(report)),
        ...(report.workflow === 'pilot'
            ? { fullAdmission: report.fullAdmission }
            : {}),
    };
}
export function checkSizes(
    value,
    context,
    phase,
    moment,
    evidenceKind,
    expectedCollectionId = null
) {
    const bindings = sizeBindings(context.state);
    const decimal = (value) =>
        typeof value === 'string' &&
        /^(0|[1-9][0-9]{0,18})$/u.test(value) &&
        BigInt(value) <= 9223372036854775807n;
    need(
        value?.schemaVersion === 1 &&
            value.kind === 'INDEPENDENT_STORE_SIZES' &&
            value.runId === context.runId &&
            value.phase === phase &&
            value.moment === moment &&
            value.evidenceKind ===
                (evidenceKind === 'LIVE_NATIVE_ISOLATED'
                    ? 'LIVE_READ_ONLY'
                    : 'SYNTHETIC_UNIT_TEST') &&
            hash(value.receiptSha256) &&
            hash(value.producerIdentitySha256) &&
            Object.entries(bindings).every(
                ([key, expected]) => value[key] === expected
            ) &&
            value.physicalVolumeBytes === null &&
            value.physicalVolumeStatus === 'UNKNOWN',
        'LOAD_RUNTIME_SIZE_PROOF'
    );
    const { receiptSha256, ...payload } = value;
    need(
        digest(payload) === receiptSha256 &&
            typeof value.startedAt === 'string' &&
            typeof value.finishedAt === 'string' &&
            Number.isFinite(Date.parse(value.startedAt)) &&
            Date.parse(value.finishedAt) >= Date.parse(value.startedAt) &&
            value.collectionId === expectedCollectionId,
        'LOAD_RUNTIME_SIZE_PROOF'
    );
    for (const key of ['application', 'vector'])
        need(
            value[key]?.scope ===
                (key === 'application' ? 'public' : 'vector_collections') &&
                decimal(value[key].databaseBytes) &&
                BigInt(value[key].databaseBytes) > 0n &&
                decimal(value[key].scopedRelationBytes) &&
                Number.isSafeInteger(value[key].relationCount) &&
                value[key].relationCount >= 0 &&
                value[key].relationCount <= SIZE_LIMITS.relations,
            'LOAD_RUNTIME_SIZE_PROOF'
        );
    encoded(value, SIZE_LIMITS.receiptBytes);
    return structuredClone(value);
}
