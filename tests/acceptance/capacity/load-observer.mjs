/** Injected, guarded native/canonical observer. No SDK, file or service is touched on import. */
import {
    need,
    id,
    hash,
    validateIdentity,
    digest,
    same,
    nativeDelta,
    stableNativeSnapshot,
} from './load-observer-core.mjs';
export const RUNTIME_DRAFT_ONLY = true;
/** Reader/store/admission are explicit capabilities. The default guarded runtime supplies real read-only implementations. */
export function createLoadObserver({
    state,
    fixture,
    admit,
    reader,
    store,
    now,
    sleep,
}) {
    validateIdentity(state, fixture);
    need(
        [
            admit,
            reader?.native,
            reader?.generation,
            store?.write,
            store?.read,
            now,
            sleep,
        ].every((fn) => typeof fn === 'function'),
        'LOAD_OBS_ADAPTER'
    );
    const validate = (input) => {
        need(
            input.runId === state.runId &&
                fixture.organizationIds.includes(input.organizationId) &&
                /^[A-Za-z0-9_-]{1,128}$/u.test(input.collectionId),
            'LOAD_OBS_SCOPE'
        );
    };
    const stable = async (input) =>
        stableNativeSnapshot(() => reader.native(input), {
            now,
            sleep,
            verify: admit,
        });
    const beginIndexObservation = async (input) => {
        validate(input);
        await admit();
        need(
            input.configurationRevision === 1 &&
                input.dimensions === 768 &&
                input.nativeIdentity === state.loadPolicy.model.digest,
            'LOAD_OBS_IDENTITY'
        );
        const before = await stable(input),
            baselineSha256 = digest(before);
        const record = {
            schemaVersion: 1,
            kind: 'LOAD_NATIVE_BASELINE_RECORD',
            runId: state.runId,
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            snapshot: before,
        };
        await store.write('baseline-' + baselineSha256 + '.json', record);
        return {
            schemaVersion: 1,
            kind: 'INDEPENDENT_NATIVE_BASELINE',
            evidenceKind: 'LIVE_READ_ONLY',
            runId: state.runId,
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            workload: 'INDEXING',
            provider: 'OLLAMA',
            stable: true,
            exclusive: true,
            baselineSha256,
            producerIdentitySha256: before.producerIdentitySha256,
        };
    };
    const observeGeneration = async (supplied) => {
        need(
            supplied.runId === undefined || supplied.runId === state.runId,
            'LOAD_OBS_SCOPE'
        );
        const input = { ...supplied, runId: state.runId };
        validate(input);
        await admit();
        need(
            id(input.generationId) &&
                Array.isArray(input.bindings) &&
                input.bindings.length <= 200 &&
                Array.isArray(input.descriptors) &&
                input.descriptors.length === input.bindings.length &&
                new Set(input.bindings.map((row) => row.documentId)).size ===
                    input.bindings.length &&
                input.bindings.every(
                    (row) => id(row.documentId) && id(row.versionId)
                ) &&
                hash(input.nativeBaseline?.baselineSha256),
            'LOAD_OBS_BOUNDS'
        );
        need(
            input.nativeBaseline?.runId === state.runId &&
                input.nativeBaseline.organizationId === input.organizationId &&
                input.nativeBaseline.collectionId === input.collectionId,
            'LOAD_OBS_BASELINE'
        );
        const saved = await store.read(
            'baseline-' + input.nativeBaseline.baselineSha256 + '.json'
        );
        need(
            saved.kind === 'LOAD_NATIVE_BASELINE_RECORD' &&
                saved.runId === input.runId &&
                saved.organizationId === input.organizationId &&
                saved.collectionId === input.collectionId &&
                digest(saved.snapshot) ===
                    input.nativeBaseline.baselineSha256 &&
                saved.snapshot.producerIdentitySha256 ===
                    input.nativeBaseline.producerIdentitySha256,
            'LOAD_OBS_BASELINE'
        );
        // Stores are consistent separately. Verify the native producer before/after catalog/vector observation too.
        const beforeGeometry = input.expectedNativeWorkProof
            ? null
            : await stable(input);
        const geometry = await reader.generation(input);
        need(
            geometry.quiescent === true &&
                geometry.generationId === input.generationId,
            'LOAD_OBS_GENERATION'
        );
        const expected = {
            children: geometry.physicalChildren,
            documents: input.bindings.length,
            preparedBytes: geometry.preparedBytes,
            estimatedInputTokens: geometry.estimatedInputTokens,
        };
        let usage;
        if (input.expectedNativeWorkProof) {
            const receipt = await store.read(
                'receipt-' +
                    input.expectedNativeWorkProof.receiptSha256 +
                    '.json'
            );
            need(
                digest(receipt) ===
                    input.expectedNativeWorkProof.receiptSha256 &&
                    receipt.kind === 'LOAD_NATIVE_WORK_RECEIPT' &&
                    receipt.baselineSha256 ===
                        input.nativeBaseline.baselineSha256 &&
                    receipt.runId === input.runId &&
                    receipt.organizationId === input.organizationId &&
                    receipt.collectionId === input.collectionId &&
                    receipt.generationId === input.generationId &&
                    receipt.manifestSha256 === geometry.manifestSha256 &&
                    same(receipt.expected, expected),
                'LOAD_OBS_RECEIPT'
            );
            usage = nativeDelta(saved.snapshot, receipt.after, expected);
            usage.nativeWorkProof.receiptSha256 = digest(receipt);
            need(
                same(usage.nativeWorkProof, input.expectedNativeWorkProof),
                'LOAD_OBS_RECEIPT'
            );
        } else {
            const after = await stable(input);
            need(same(beforeGeometry, after), 'LOAD_OBS_NOT_STABLE');
            usage = nativeDelta(saved.snapshot, after, expected);
            const receipt = {
                schemaVersion: 1,
                kind: 'LOAD_NATIVE_WORK_RECEIPT',
                runId: input.runId,
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: input.generationId,
                baselineSha256: input.nativeBaseline.baselineSha256,
                manifestSha256: geometry.manifestSha256,
                expected,
                after,
            };
            const receiptSha256 = digest(receipt);
            await store.write('receipt-' + receiptSha256 + '.json', receipt);
            usage.nativeWorkProof.receiptSha256 = receiptSha256;
        }
        const { preparedBytes, estimatedInputTokens, ...safe } = geometry;
        return {
            ...safe,
            schemaVersion: 1,
            kind: 'INDEPENDENT_READ_ONLY',
            evidenceKind: 'LIVE_READ_ONLY',
            runId: input.runId,
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            configurationRevision: 1,
            status: 'ACTIVE',
            usage,
        };
    };
    return { beginIndexObservation, observeGeneration };
}
