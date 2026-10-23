/** Guarded, injected normal importer. No file, SQL, model, HTTP or process adapter is constructed here. */
import {
    LOAD_LIMITS,
    need,
    id,
    validateManifest,
    validateReferences,
    loadDescriptor,
    importContext,
    readList,
    sha,
    loadResourcePolicyHash,
} from './load-import-core.mjs';
import { loadPolicyForState, policySha256 } from './load-policy-registry.mjs';
import {
    importDocuments,
    verifyExistingDocuments,
    attachDocuments,
} from './load-import-documents.mjs';
import {
    createCollection,
    startCollection,
    verifyCollection,
} from './load-import-collections.mjs';
export const RUNTIME_DRAFT_ONLY = true;
const refDescriptors = (references) =>
    references.manifest.documents.map((doc) => ({ ...doc }));
const summaryCollection = (collection) => structuredClone(collection);
function validateReport(report, ctx, workflow) {
    need(
        report?.schemaVersion === 1 &&
            report.namespace === ctx.state.namespace &&
            report.runId === ctx.state.runId &&
            report.workflow === workflow &&
            report.status === 'COMPLETE' &&
            report.evidenceKind === ctx.evidenceKind,
        'LOAD_PRIOR_REPORT'
    );
    need(
        report.experimentPolicyId === ctx.policy.id &&
            report.policySha256 === policySha256(ctx.policy),
        'LOAD_PRIOR_REPORT'
    );
}
async function inventory(ctx, expected) {
    for (const role of ['owner', 'foreign'])
        for (const section of ['documents', 'collections']) {
            const rows = await readList(ctx, role, section),
                ids = expected[role][section];
            need(
                rows.length === ids.length &&
                    rows.every((row) => ids.includes(row.id)),
                'LOAD_UNEXPECTED_INVENTORY'
            );
        }
}
function baselineExpected(
    report,
    ownerDocuments = [],
    extraOwnerCollections = []
) {
    return {
        owner: {
            documents: ownerDocuments,
            collections: [
                report.collections.ingestionA.collectionId,
                ...extraOwnerCollections,
            ],
        },
        foreign: {
            documents: report.documents.referenceB.map((row) => row.documentId),
            collections: [
                report.collections.referenceB.collectionId,
                report.collections.ingestionB.collectionId,
            ],
        },
    };
}
async function verifyBaseline(
    ctx,
    report,
    references,
    observeGeneration,
    ownerDocuments = [],
    extraOwnerCollections = []
) {
    validateReport(report, ctx, 'baseline');
    need(
        report.referenceDigest === ctx.policy.identity.reference &&
            report.documents.referenceB?.length === 24,
        'LOAD_PRIOR_REPORT'
    );
    for (const collectionRole of ['referenceB', 'ingestionA', 'ingestionB'])
        need(
            report.collections[collectionRole]?.collectionRole ===
                collectionRole &&
                report.collections[collectionRole].policySha256 ===
                    policySha256(ctx.policy),
            'LOAD_PRIOR_REPORT'
        );
    need(
        new Set(
            Object.values(report.collections).map((row) => row.collectionId)
        ).size === 3,
        'LOAD_PRIOR_REPORT'
    );
    await inventory(
        ctx,
        baselineExpected(report, ownerDocuments, extraOwnerCollections)
    );
    const descriptors = refDescriptors(references);
    need(
        report.documents.referenceB.every(
            (row, index) => row.fixtureId === descriptors[index].fixtureId
        ),
        'LOAD_PRIOR_REPORT'
    );
    await verifyCollection(
        ctx,
        'foreign',
        report.collections.referenceB,
        report.documents.referenceB,
        descriptors,
        observeGeneration
    );
    await verifyCollection(
        ctx,
        'owner',
        report.collections.ingestionA,
        [],
        [],
        observeGeneration
    );
    await verifyCollection(
        ctx,
        'foreign',
        report.collections.ingestionB,
        [],
        [],
        observeGeneration
    );
}
function completed(ctx, result) {
    return {
        schemaVersion: 1,
        namespace: ctx.state.namespace,
        runId: ctx.state.runId,
        workflow: ctx.workflow,
        status: 'COMPLETE',
        evidenceKind: ctx.evidenceKind,
        experimentPolicyId: ctx.policy.id,
        policySha256: policySha256(ctx.policy),
        acceptance:
            ctx.evidenceKind === 'LIVE_NATIVE_ISOLATED'
                ? ctx.workflow === 'pilot'
                    ? 'PILOT_PREPARED'
                    : ctx.workflow === 'full'
                      ? 'FULL_INDEX_PREPARED'
                      : 'BASELINE_PREPARED'
                : 'NOT_RUN',
        capacityAcceptance: 'NOT_RUN',
        trafficAcceptance: 'NOT_RUN',
        ...result,
    };
}
/** Prepare B's unchanged reference and two serving ingestion collections before the A pilot stopwatch. */
export async function prepareLoadBaseline(options) {
    const ctx = importContext({ ...options, workflow: 'baseline' }),
        references = validateReferences(options.references, ctx.policy);
    need(
        typeof options.observeGeneration === 'function' &&
            typeof options.beginIndexObservation === 'function',
        'LOAD_OBSERVER_REQUIRED'
    );
    try {
        if (options.completedReport) {
            await verifyBaseline(
                ctx,
                options.completedReport,
                references,
                options.observeGeneration
            );
            return await ctx.finish({
                ...options.completedReport,
                reusedValidatedBaseline: true,
            });
        }
        await ctx.stage('VERIFY_EMPTY_BASELINE');
        await inventory(ctx, {
            owner: { documents: [], collections: [] },
            foreign: { documents: [], collections: [] },
        });
        const deadline = ctx.time() + LOAD_LIMITS.setupMs;
        await ctx.stage('IMPORT_REFERENCE_B');
        const descriptors = refDescriptors(references),
            bindings = await importDocuments(
                ctx,
                'foreign',
                descriptors,
                options.readOriginal,
                { deadline }
            );
        const reference = await createCollection(
            ctx,
            'foreign',
            'reference-B',
            references.manifest.metadataFields,
            'referenceB'
        );
        await attachDocuments(
            ctx,
            'foreign',
            reference,
            bindings,
            descriptors,
            deadline
        );
        const referenceB = await startCollection(
            ctx,
            'foreign',
            reference,
            bindings,
            descriptors,
            {
                observeGeneration: options.observeGeneration,
                beginIndexObservation: options.beginIndexObservation,
                expectedChildren: null,
                expectedParents: null,
                budgetMs: Math.max(1, deadline - ctx.time()),
                absoluteDeadline: deadline,
            }
        );
        need(ctx.time() <= deadline, 'LOAD_PHASE_DEADLINE');
        await ctx.stage('PREPARE_SERVING_INGESTION_COLLECTIONS');
        const ingestionA = await startCollection(
            ctx,
            'owner',
            await createCollection(
                ctx,
                'owner',
                'ingestion-A',
                undefined,
                'ingestionA'
            ),
            [],
            [],
            {
                observeGeneration: options.observeGeneration,
                beginIndexObservation: options.beginIndexObservation,
                expectedChildren: 0,
                expectedParents: 0,
                budgetMs: Math.max(1, deadline - ctx.time()),
                absoluteDeadline: deadline,
            }
        );
        const ingestionB = await startCollection(
            ctx,
            'foreign',
            await createCollection(
                ctx,
                'foreign',
                'ingestion-B',
                undefined,
                'ingestionB'
            ),
            [],
            [],
            {
                observeGeneration: options.observeGeneration,
                beginIndexObservation: options.beginIndexObservation,
                expectedChildren: 0,
                expectedParents: 0,
                budgetMs: Math.max(1, deadline - ctx.time()),
                absoluteDeadline: deadline,
            }
        );
        need(ctx.time() <= deadline, 'LOAD_PHASE_DEADLINE');
        const report = completed(ctx, {
            referenceDigest: ctx.policy.identity.reference,
            documents: { referenceB: bindings },
            collections: {
                referenceB: summaryCollection(referenceB),
                ingestionA: summaryCollection(ingestionA),
                ingestionB: summaryCollection(ingestionB),
            },
            timing: { setupMs: ctx.time() - ctx.started },
        });
        await verifyBaseline(
            ctx,
            report,
            references,
            options.observeGeneration
        );
        return await ctx.finish(report);
    } catch (error) {
        return await ctx.fail(error);
    }
}
function resources(value, ctx, indexMs) {
    need(
        value?.schemaVersion === 1 &&
            value.kind === 'INDEPENDENT_RESOURCE_SAMPLES' &&
            value.runId === ctx.state.runId &&
            value.evidenceKind ===
                (ctx.evidenceKind === 'LIVE_NATIVE_ISOLATED'
                    ? 'LIVE_READ_ONLY'
                    : 'SYNTHETIC_UNIT_TEST') &&
            Number.isSafeInteger(value.samples) &&
            value.samples >= 2 &&
            Number.isSafeInteger(value.durationMs) &&
            value.durationMs >= indexMs &&
            Number.isSafeInteger(value.minimumFreeBytes) &&
            value.minimumFreeBytes >= LOAD_LIMITS.freeBytes &&
            Number.isSafeInteger(value.peakMemoryBytes) &&
            value.peakMemoryBytes > 0 &&
            value.resourcePolicySha256 === loadResourcePolicyHash(ctx.state) &&
            ['WARM', 'COLD', 'UNKNOWN'].includes(value.modelWarmState) &&
            value.oom === false &&
            value.processLost === false &&
            value.safetyReserveBreached === false,
        'LOAD_RESOURCE_PROOF'
    );
    return {
        minimumFreeBytes: value.minimumFreeBytes,
        peakMemoryBytes: value.peakMemoryBytes,
        modelWarmState: value.modelWarmState,
        samples: value.samples,
        durationMs: value.durationMs,
        resourcePolicySha256: value.resourcePolicySha256,
    };
}
/** Reject unsafe or incomplete pilot projection before any full-workflow API mutation. */
export function validatePilotGate(pilot, { state, evidenceKind }) {
    const policy = loadPolicyForState(state);
    need(
        pilot?.schemaVersion === 1 &&
            pilot.namespace === policy.namespace &&
            pilot.experimentPolicyId === policy.id &&
            pilot.policySha256 === policySha256(policy) &&
            pilot.runId === state.runId &&
            pilot.workflow === 'pilot' &&
            pilot.status === 'COMPLETE' &&
            pilot.evidenceKind === evidenceKind &&
            pilot.familySha256 === policy.identity.family &&
            pilot.corpusSha256 === policy.identity.pilot &&
            pilot.acceptance ===
                (evidenceKind === 'LIVE_NATIVE_ISOLATED'
                    ? 'PILOT_PREPARED'
                    : 'NOT_RUN') &&
            pilot.documents?.loadA?.length === 4 &&
            Number.isSafeInteger(pilot.timing?.pilotIndexMs) &&
            pilot.timing.pilotIndexMs > 0 &&
            pilot.timing.pilotIndexMs * 50 <= LOAD_LIMITS.fullMs &&
            pilot.pilotObservation?.physicalChildren === 2000 &&
            pilot.pilotObservation.validatedNativeVectors === 2000 &&
            pilot.pilotObservation.retries === 0 &&
            pilot.pilotObservation.errors === 0 &&
            Number.isSafeInteger(pilot.pilotObservation.minimumFreeBytes) &&
            pilot.pilotObservation.minimumFreeBytes >= LOAD_LIMITS.freeBytes &&
            Number.isSafeInteger(pilot.pilotObservation.peakMemoryBytes) &&
            pilot.pilotObservation.peakMemoryBytes > 0 &&
            ['WARM', 'COLD', 'UNKNOWN'].includes(
                pilot.pilotObservation.modelWarmState
            ) &&
            pilot.pilotObservation.resourcePolicySha256 ===
                loadResourcePolicyHash(state),
        'LOAD_PILOT_ADMISSION'
    );
    need(
        id(pilot.collections?.pilot?.collectionId) &&
            id(pilot.collections.pilot.generationId) &&
            pilot.collections.pilot.activeChildren === 2000 &&
            pilot.collections.pilot.parents === 500 &&
            pilot.collections.pilot.collectionRole === 'pilotA' &&
            pilot.collections.pilot.policySha256 === policySha256(policy),
        'LOAD_PILOT_ADMISSION'
    );
    return pilot;
}
/** First four sources perform genuine native work; no synthetic result is labeled live. */
export async function importLoadPilot(options) {
    const ctx = importContext({ ...options, workflow: 'pilot' }),
        manifest = validateManifest(options.manifest, ctx.policy),
        references = validateReferences(options.references, ctx.policy);
    need(
        typeof options.observeGeneration === 'function' &&
            typeof options.beginIndexObservation === 'function' &&
            typeof options.beginMeasurements === 'function',
        'LOAD_OBSERVER_REQUIRED'
    );
    try {
        await ctx.stage('VERIFY_QUIESCENT_BASELINE');
        await verifyBaseline(
            ctx,
            options.baselineReport,
            references,
            options.observeGeneration
        );
        const deadline = ctx.time() + LOAD_LIMITS.pilotMs,
            descriptors = manifest.documents
                .slice(0, 4)
                .map((doc) => loadDescriptor(doc, ctx.policy));
        await ctx.stage('UPLOAD_PILOT_SOURCES');
        const bindings = await importDocuments(
            ctx,
            'owner',
            descriptors,
            options.readOriginal,
            { deadline }
        );
        const collection = await createCollection(
            ctx,
            'owner',
            'pilot',
            undefined,
            'pilotA'
        );
        await attachDocuments(
            ctx,
            'owner',
            collection,
            bindings,
            descriptors,
            deadline
        );
        await ctx.stage('INDEX_PILOT');
        const measurement = await options.beginMeasurements({
            runId: ctx.state.runId,
            phase: 'pilot',
            collectionId: collection.collectionId,
        });
        need(typeof measurement?.finish === 'function', 'LOAD_RESOURCE_PROOF');
        let pilot, resource;
        try {
            pilot = await startCollection(
                ctx,
                'owner',
                collection,
                bindings,
                descriptors,
                {
                    observeGeneration: options.observeGeneration,
                    beginIndexObservation: options.beginIndexObservation,
                    expectedChildren: 2000,
                    expectedParents: 500,
                    budgetMs: Math.max(1, deadline - ctx.time()),
                    absoluteDeadline: deadline,
                }
            );
        } finally {
            resource = await measurement.finish();
        }
        need(
            ctx.time() <= deadline && pilot.indexMs > 0,
            'LOAD_PHASE_DEADLINE'
        );
        const resourceProof = resources(resource, ctx, pilot.indexMs);
        const report = completed(ctx, {
            corpusSha256: ctx.policy.identity.pilot,
            familySha256: ctx.policy.identity.family,
            baseline: structuredClone(options.baselineReport),
            documents: { loadA: bindings },
            collections: { pilot: summaryCollection(pilot) },
            timing: {
                pilotIndexMs: pilot.indexMs,
                setupMs: ctx.time() - ctx.started,
                definition: 'CLIENT_START_CALL_TO_OBSERVED_ACTIVE',
            },
            pilotObservation: { ...pilot.observation, ...resourceProof },
            fullProjectionMs: pilot.indexMs * 50,
            fullAdmission:
                pilot.indexMs * 50 <= LOAD_LIMITS.fullMs
                    ? 'WITHIN_FIXED_PROJECTION'
                    : 'REFUSED_PROJECTION',
        });
        return await ctx.finish(report);
    } catch (error) {
        return await ctx.fail(error);
    }
}
/** A new full generation embeds all200 originals; pilot vectors are never adopted/copied. */
export async function importLoadFull(options) {
    const policy = loadPolicyForState(options.state),
        manifest = validateManifest(options.manifest, policy),
        references = validateReferences(options.references, policy);
    validatePilotGate(options.pilotReport, {
        state: options.state,
        evidenceKind: options.evidenceKind ?? 'SYNTHETIC_UNIT_TEST',
    });
    const ctx = importContext({ ...options, workflow: 'full' });
    need(
        typeof options.observeGeneration === 'function' &&
            typeof options.beginIndexObservation === 'function' &&
            typeof options.beginMeasurements === 'function',
        'LOAD_OBSERVER_REQUIRED'
    );
    try {
        const prior = options.pilotReport,
            baseline = prior.baseline,
            first = manifest.documents
                .slice(0, 4)
                .map((doc) => loadDescriptor(doc, ctx.policy));
        await ctx.stage('VERIFY_PILOT_ADMISSION');
        await verifyBaseline(
            ctx,
            baseline,
            references,
            options.observeGeneration,
            prior.documents.loadA.map((row) => row.documentId),
            [prior.collections.pilot.collectionId]
        );
        await verifyExistingDocuments(
            ctx,
            'owner',
            prior.documents.loadA,
            first
        );
        await verifyCollection(
            ctx,
            'owner',
            prior.collections.pilot,
            prior.documents.loadA,
            first,
            options.observeGeneration
        );
        await ctx.stage('UPLOAD_FULL_SOURCES');
        const rest = manifest.documents
            .slice(4)
            .map((doc) => loadDescriptor(doc, ctx.policy));
        const added = await importDocuments(
            ctx,
            'owner',
            rest,
            options.readOriginal,
            {
                existing: prior.documents.loadA,
                deadline: ctx.time() + LOAD_LIMITS.sourceImportMs,
            }
        );
        const bindings = [...prior.documents.loadA, ...added],
            descriptors = [...first, ...rest];
        const collection = await createCollection(
            ctx,
            'owner',
            'full',
            undefined,
            'primaryA'
        );
        need(
            collection.collectionId !== prior.collections.pilot.collectionId,
            'LOAD_NEW_GENERATION_REQUIRED'
        );
        await attachDocuments(ctx, 'owner', collection, bindings, descriptors);
        await ctx.stage('INDEX_ALL_FULL_SOURCES');
        const measurement = await options.beginMeasurements({
            runId: ctx.state.runId,
            phase: 'full',
            collectionId: collection.collectionId,
        });
        need(typeof measurement?.finish === 'function', 'LOAD_RESOURCE_PROOF');
        let full, resource;
        try {
            full = await startCollection(
                ctx,
                'owner',
                collection,
                bindings,
                descriptors,
                {
                    observeGeneration: options.observeGeneration,
                    beginIndexObservation: options.beginIndexObservation,
                    expectedChildren: 100000,
                    expectedParents: 25000,
                    budgetMs: LOAD_LIMITS.fullMs,
                }
            );
        } finally {
            resource = await measurement.finish();
        }
        need(
            full.generationId !== prior.collections.pilot.generationId &&
                full.indexMs <= LOAD_LIMITS.fullMs,
            'LOAD_NEW_GENERATION_REQUIRED'
        );
        const resourceProof = resources(resource, ctx, full.indexMs);
        await ctx.stage('VERIFY_UNCHANGED_BASELINE');
        await verifyBaseline(
            ctx,
            baseline,
            references,
            options.observeGeneration,
            bindings.map((row) => row.documentId),
            [prior.collections.pilot.collectionId, full.collectionId]
        );
        return await ctx.finish(
            completed(ctx, {
                corpusSha256: ctx.policy.identity.full,
                familySha256: ctx.policy.identity.family,
                pilotReportSha256: sha(JSON.stringify(prior)),
                baseline: structuredClone(baseline),
                documents: { loadA: bindings },
                collections: {
                    primary: summaryCollection(full),
                    pilot: structuredClone(prior.collections.pilot),
                },
                timing: {
                    fullIndexMs: full.indexMs,
                    overallMs: ctx.time() - ctx.started,
                    definition: 'CLIENT_START_CALL_TO_OBSERVED_ACTIVE',
                },
                fullObservation: { ...full.observation, ...resourceProof },
            })
        );
    } catch (error) {
        return await ctx.fail(error);
    }
}
