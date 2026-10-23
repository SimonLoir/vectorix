/** Pure/injected load acceptance support. No SDK, file, process, network or database work on import. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    getLoadPolicy,
    loadPolicyForState,
    policySha256,
    profileForCollectionRole,
} from './load-policy-registry.mjs';
import {
    validateLoadTransportState,
    LoadTransportError,
} from './load-transport.mjs';
export const RUNTIME_DRAFT_ONLY = true;
// The explicit default remains useful to old pure geometry consumers. Runtime contexts
// always select the strict state-bound descriptor and never mutate this alias.
export const LOAD_IDENTITY = getLoadPolicy('DEFAULT_V1').identity;
export const LOAD_LIMITS = Object.freeze({
    documents: 240,
    collections: 20,
    calls: 20000,
    journalBytes: 512 * 1024,
    sourceBytes: 1024 * 1024,
    overallMs: 180 * 60 * 1000,
    setupMs: 20 * 60 * 1000,
    pilotMs: 20 * 60 * 1000,
    sourceImportMs: 20 * 60 * 1000,
    fullMs: 120 * 60 * 1000,
    pollMs: 2000,
    freeBytes: 4 * 1024 ** 3,
});
export class LoadImportError extends Error {
    constructor(code, acceptance = 'NOT_APPLICABLE') {
        super(/^LOAD_[A-Z_]{1,80}$/u.test(code) ? code : 'LOAD_IMPORT_FAILED');
        this.code = this.message;
        this.acceptance = [
            'NOT_SENT',
            'REJECTED',
            'UNKNOWN',
            'NOT_APPLICABLE',
        ].includes(acceptance)
            ? acceptance
            : 'UNKNOWN';
    }
}
export const need = (value, code) => {
    if (!value) throw new LoadImportError(code);
};
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const same = isDeepStrictEqual;
export const id = (value) =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
export const hash = (value) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return (
            '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
                .join(',') +
            '}'
        );
    return JSON.stringify(value);
}
/** Match the pilot/full immutable preselected deployment policy, never credentials or mutable process IDs. */
export function loadResourcePolicyHash(state) {
    need(
        /^[a-f0-9]{40}$/u.test(state.commit) &&
            state.images &&
            state.resourceLimits &&
            state.loadPolicy,
        'LOAD_RESOURCE_POLICY'
    );
    return sha(
        canonical({
            commit: state.commit,
            images: state.images,
            resourceLimits: state.resourceLimits,
            loadPolicy: state.loadPolicy,
        })
    );
}

export const safeError = (error) =>
    error instanceof LoadImportError
        ? error.code
        : error?.status === 401
          ? 'LOAD_UNAUTHORIZED'
          : error?.status === 403
            ? 'LOAD_FORBIDDEN'
            : error?.status === 429
              ? 'LOAD_RATE_REJECTED'
              : error instanceof LoadTransportError
                ? error.code
                : 'LOAD_IMPORT_FAILED';
export const fields = Object.freeze({
    topic: 'STRING',
    document_no: 'NUMBER',
    active: 'BOOLEAN',
    dataset: 'STRING',
});
export function loadProfile(
    metadataFields = fields,
    { policy = getLoadPolicy('DEFAULT_V1'), collectionRole = 'primaryA' } = {}
) {
    return profileForCollectionRole(policy, collectionRole, metadataFields);
}
export function validateManifest(
    manifest,
    policy = getLoadPolicy('DEFAULT_V1')
) {
    policySha256(policy);
    need(
        manifest?.namespace === policy.namespace &&
            manifest.version === policy.version &&
            manifest.formatVersion === 1 &&
            manifest.familySha256 === policy.identity.family &&
            manifest.corpusSha256 === policy.identity.full &&
            Array.isArray(manifest.documents) &&
            manifest.documents.length === 200,
        'LOAD_FROZEN_CORPUS'
    );
    need(
        sha(
            JSON.stringify({
                familySha256: manifest.familySha256,
                documents: manifest.documents,
            })
        ) === manifest.corpusSha256,
        'LOAD_FROZEN_CORPUS'
    );
    manifest.documents.forEach((doc, index) =>
        need(
            doc.index === index + 1 &&
                doc.id ===
                    `${policy.documentIdPrefix}${String(index + 1).padStart(4, '0')}` &&
                doc.filename === `${doc.id}-${index % 2 ? 'fr' : 'en'}.txt` &&
                doc.language === (index % 2 ? 'FR' : 'EN') &&
                doc.bytes === policy.documentBytes &&
                doc.children === 500 &&
                doc.actualChildren === 500 &&
                doc.actualParents === 125 &&
                doc.canonicalSha256 === doc.sourceSha256 &&
                hash(doc.sourceSha256) &&
                doc.chunkerVersion === 'token-window-utf8-v1' &&
                doc.parentContextVersion === 'parent-context-utf8-v1' &&
                Number.isSafeInteger(doc.utf16Units) &&
                doc.utf16Units > 0 &&
                doc.utf16Units <= doc.bytes,
            'LOAD_FROZEN_CORPUS'
        )
    );
    need(
        sha(
            JSON.stringify({
                familySha256: manifest.familySha256,
                documents: manifest.documents.slice(0, 4),
            })
        ) === policy.identity.pilot,
        'LOAD_FROZEN_CORPUS'
    );
    return manifest;
}
export function validateReferences(
    fixtures,
    policy = getLoadPolicy('DEFAULT_V1')
) {
    policySha256(policy);
    const m = fixtures?.manifest;
    need(
        sha(JSON.stringify(m)) ===
            'c61887f36391043f56637c1b448fef4165cb8a70e653e58dc0542a9b1ec372b2' &&
            m?.corpusDigest === policy.identity.reference &&
            m.offsetUnit === 'UTF16_CODE_UNITS' &&
            m.documents?.length === 24,
        'LOAD_REFERENCE_CORPUS'
    );
    need(
        new Set(m.documents.map((doc) => doc.fixtureId)).size === 24,
        'LOAD_REFERENCE_CORPUS'
    );
    for (const doc of m.documents) {
        const artifact = fixtures.artifacts?.[doc.fixtureId];
        need(
            id(doc.fixtureId) &&
                /^[A-Za-z0-9_.-]{1,160}$/u.test(doc.fileName) &&
                ['EN', 'FR'].includes(doc.language) &&
                hash(doc.originalSha256) &&
                hash(doc.canonicalSha256) &&
                doc.version === 1 &&
                Number.isSafeInteger(doc.originalBytes) &&
                doc.originalBytes > 0 &&
                doc.originalBytes <= LOAD_LIMITS.sourceBytes &&
                artifact?.text?.length === doc.canonicalLength &&
                sha(artifact.text) === doc.canonicalSha256,
            'LOAD_REFERENCE_CORPUS'
        );
    }
    return fixtures;
}
/** Each mutation is checkpointed before dispatch; accepted or ambiguous work is never automatically replayed. */
export function importContext({
    state,
    fixture,
    api,
    checkpoint,
    now = Date.now,
    sleep,
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
    workflow,
    priorJournal = null,
}) {
    validateLoadTransportState(state, fixture);
    const policy = loadPolicyForState(state);
    need(
        ['pilot', 'full', 'baseline'].includes(workflow) &&
            state.namespace === policy.namespace &&
            fixture.namespace === state.namespace &&
            state.runId === fixture.runId &&
            /^[a-f0-9]{12}$/u.test(state.runId) &&
            ['LIVE_NATIVE_ISOLATED', 'SYNTHETIC_UNIT_TEST'].includes(
                evidenceKind
            ) &&
            typeof api?.call === 'function' &&
            typeof checkpoint === 'function' &&
            typeof sleep === 'function' &&
            typeof now === 'function',
        'LOAD_IMPORT_CONFIG'
    );
    need(priorJournal === null, 'LOAD_PARTIAL_REPLAY_REFUSED');
    let started = now(),
        last = started,
        calls = 0;
    const journal = {
        schemaVersion: 1,
        namespace: state.namespace,
        runId: state.runId,
        workflow,
        experimentPolicyId: policy.id,
        policySha256: policySha256(policy),
        evidenceKind,
        status: 'IN_PROGRESS',
        stage: 'ADMISSION',
        mutations: [],
    };
    const time = () => {
        const value = now();
        need(
            Number.isSafeInteger(value) &&
                value >= last &&
                value - started <= LOAD_LIMITS.overallMs,
            'LOAD_IMPORT_DEADLINE'
        );
        last = value;
        return value;
    };
    const store = async () => {
        need(
            Buffer.byteLength(JSON.stringify(journal)) <=
                LOAD_LIMITS.journalBytes,
            'LOAD_JOURNAL_CAP'
        );
        await checkpoint(structuredClone(journal));
    };
    const call = async (role, operation, input) => {
        time();
        need(++calls <= LOAD_LIMITS.calls, 'LOAD_CALL_CAP');
        const response = await api.call(role, operation, input);
        need(
            response?.http?.status === 200 &&
                Number.isSafeInteger(response.http.responseBytes) &&
                response.http.responseBytes >= 0 &&
                response.http.responseBytes <= 2 * 1024 * 1024 &&
                Number.isSafeInteger(response.http.startedMicros) &&
                response.http.startedMicros >= 0 &&
                response.http.bodyReadMicros >= response.http.startedMicros &&
                response.http.endedMicros >= response.http.bodyReadMicros,
            'LOAD_ACTUAL_HTTP_PROOF'
        );
        time();
        return response.value;
    };
    const mutate = async (role, operation, input, project) => {
        need(journal.mutations.length < 1500, 'LOAD_MUTATION_CAP');
        const action = {
            ordinal: journal.mutations.length + 1,
            role,
            operation,
            status: 'PENDING',
            ...(input.requestId ? { requestId: input.requestId } : {}),
            ...(input.id ? { documentId: input.id } : {}),
            ...(input.collectionId ? { collectionId: input.collectionId } : {}),
        };
        journal.mutations.push(action);
        await store();
        try {
            const value = await call(role, operation, input);
            const safe = project(value);
            Object.assign(action, { status: 'CONFIRMED', ...safe });
            await store();
            return value;
        } catch (error) {
            const acceptance = ['NOT_SENT', 'REJECTED', 'UNKNOWN'].includes(
                error?.acceptance
            )
                ? error.acceptance
                : 'UNKNOWN';
            action.acceptance = acceptance;
            throw new LoadImportError(safeError(error), acceptance);
        }
    };
    const wait = async (read, check, deadline) => {
        let polls = 0;
        while (time() <= deadline) {
            need(++polls <= 4000, 'LOAD_POLL_CAP');
            const value = await read();
            need(time() <= deadline, 'LOAD_PHASE_DEADLINE');
            if (check(value)) return value;
            const target = time() + LOAD_LIMITS.pollMs;
            need(target <= deadline, 'LOAD_PHASE_DEADLINE');
            let wakes = 0;
            // Timers may wake early. Complete this one polling interval before another read;
            // short wakeups are local waits, never additional API polls or an extended deadline.
            while (time() < target) {
                need(++wakes <= 64, 'LOAD_CLOCK_NOT_ADVANCED');
                const before = time();
                need(before < deadline, 'LOAD_PHASE_DEADLINE');
                await sleep(Math.ceil(target - before));
                // The runtime clock is floored to milliseconds: a short wake may
                // legitimately retain the same integer. time() rejects reversal.
                need(time() <= deadline, 'LOAD_PHASE_DEADLINE');
            }
        }
        throw new LoadImportError('LOAD_PHASE_DEADLINE');
    };
    return {
        state,
        policy,
        fixture,
        api,
        workflow,
        evidenceKind,
        journal,
        started,
        time,
        store,
        call,
        mutate,
        wait,
        stage: async (stage) => {
            journal.stage = stage;
            await store();
        },
        finish: async (result) => {
            journal.status = 'COMPLETE';
            journal.stage = 'COMPLETE';
            await store();
            return { ...result, recordedCalls: calls };
        },
        fail: async (error) => {
            journal.status = 'INCOMPLETE';
            journal.errorCode = safeError(error);
            journal.acceptance = [
                'NOT_SENT',
                'REJECTED',
                'UNKNOWN',
                'NOT_APPLICABLE',
            ].includes(error?.acceptance)
                ? error.acceptance
                : 'UNKNOWN';
            try {
                await store();
            } catch {}
            throw new LoadImportError(journal.errorCode, journal.acceptance);
        },
    };
}
export async function readList(ctx, role, section) {
    const rows = [];
    let total = null;
    for (let offset = 0; offset < LOAD_LIMITS.documents; offset += 100) {
        const page = await ctx.call(role, `${section}.list`, {
            offset,
            limit: 100,
            query: '',
        });
        need(
            Array.isArray(page.items) &&
                page.items.length <= 100 &&
                Number.isSafeInteger(page.total) &&
                page.total >= 0 &&
                page.total <= (section === 'documents' ? 240 : 20),
            'LOAD_INVENTORY_CAP'
        );
        if (total === null) total = page.total;
        need(page.total === total, 'LOAD_INVENTORY_CHANGED');
        rows.push(...page.items);
        if (rows.length >= total) break;
    }
    need(
        rows.length === total &&
            rows.every((row) => id(row.id)) &&
            new Set(rows.map((row) => row.id)).size === rows.length,
        'LOAD_INVENTORY_CHANGED'
    );
    return rows;
}
export function loadDescriptor(doc, policy = getLoadPolicy('DEFAULT_V1')) {
    policySha256(policy);
    return {
        fixtureId: doc.id,
        fileName: doc.filename,
        language: doc.language,
        mediaType: 'text/plain',
        originalBytes: doc.bytes,
        originalSha256: doc.sourceSha256,
        canonicalSha256: doc.canonicalSha256,
        canonicalLength: doc.utf16Units,
        expectedGeometrySha256: doc.geometrySha256,
        metadata: {
            topic: doc.topic,
            document_no: doc.index,
            active: true,
            dataset: policy.version,
        },
        tags: [policy.version, doc.language.toLowerCase(), doc.topic],
    };
}
export function requestId() {
    return randomUUID();
}
