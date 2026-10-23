/** Normal saved collections, native probes and independently observed publication gates. */
import {
    need,
    id,
    hash,
    same,
    loadProfile,
    LOAD_IDENTITY,
    LOAD_LIMITS,
    requestId,
} from './load-import-core.mjs';
export async function createCollection(ctx, role, label, metadataFields) {
    const profile = loadProfile(metadataFields),
        name = `M7c load ${ctx.state.runId} ${label}`;
    const created = await ctx.mutate(
        role,
        'collections.create',
        {
            name,
            description:
                'Artificial bounded native capacity acceptance; no production content.',
            profile,
            grantCreatorRead: true,
        },
        (value) => {
            need(
                id(value.id) &&
                    value.name === name &&
                    value.configurationRevision === 1 &&
                    Object.entries(profile).every(([key, value2]) =>
                        same(value.configuration?.[key], value2)
                    ) &&
                    value.permissions?.read === true &&
                    value.permissions.manageDocuments === true &&
                    value.permissions.administer === true,
                'LOAD_SAVED_PROFILE'
            );
            return { collectionId: value.id, configurationRevision: 1 };
        }
    );
    return { collectionId: created.id, configurationRevision: 1, profile };
}
export async function probeCollection(ctx, role, collection) {
    const probe = await ctx.call(role, 'indexing.probe', {
        collectionId: collection.collectionId,
        expectedRevision: 1,
    });
    need(
        probe.provider === 'OLLAMA' &&
            probe.model === 'embeddinggemma:latest' &&
            probe.digest === LOAD_IDENTITY.weights &&
            probe.dimensions === 768 &&
            probe.preset === 'EMBEDDING_GEMMA' &&
            probe.identityKind === 'WEIGHTS_DIGEST' &&
            Number.isInteger(probe.contextTokens) &&
            probe.contextTokens >= 1608,
        'LOAD_NATIVE_PROBE'
    );
    return {
        digest: probe.digest,
        dimensions: probe.dimensions,
        contextTokens: probe.contextTokens,
        preset: probe.preset,
        identityKind: probe.identityKind,
    };
}
/** Capture native accounting before each start, including reference/empty baselines, after probe traffic ends. */
function validateNativeBaseline(baseline, ctx, role, collection) {
    need(
        Object.keys(baseline ?? {})
            .sort()
            .join(',') ===
            'baselineSha256,collectionId,evidenceKind,exclusive,kind,organizationId,producerIdentitySha256,provider,runId,schemaVersion,stable,workload' &&
            baseline?.schemaVersion === 1 &&
            baseline.kind === 'INDEPENDENT_NATIVE_BASELINE' &&
            baseline.evidenceKind ===
                (ctx.evidenceKind === 'LIVE_NATIVE_ISOLATED'
                    ? 'LIVE_READ_ONLY'
                    : 'SYNTHETIC_UNIT_TEST') &&
            baseline.runId === ctx.state.runId &&
            baseline.organizationId ===
                ctx.fixture.users[role].organizationId &&
            baseline.collectionId === collection.collectionId &&
            baseline.workload === 'INDEXING' &&
            baseline.provider === 'OLLAMA' &&
            baseline.stable === true &&
            baseline.exclusive === true &&
            hash(baseline.baselineSha256) &&
            hash(baseline.producerIdentitySha256),
        'LOAD_NATIVE_BASELINE'
    );
    need(
        Buffer.byteLength(JSON.stringify(baseline)) <= 2048,
        'LOAD_NATIVE_BASELINE'
    );
    return structuredClone(baseline);
}
/** The observer is an explicit external proof interface, not an API count or a fabricated fallback. */
export function validateGenerationObservation(
    observation,
    {
        ctx,
        role,
        collection,
        bindings,
        descriptors,
        expectedChildren,
        expectedParents,
        nativeBaseline,
        expectedNativeWorkProof = null,
    }
) {
    validateNativeBaseline(nativeBaseline, ctx, role, collection);
    need(
        observation?.schemaVersion === 1 &&
            observation.runId === ctx.state.runId &&
            observation.kind === 'INDEPENDENT_READ_ONLY' &&
            observation.evidenceKind ===
                (ctx.evidenceKind === 'LIVE_NATIVE_ISOLATED'
                    ? 'LIVE_READ_ONLY'
                    : 'SYNTHETIC_UNIT_TEST') &&
            observation.organizationId ===
                ctx.fixture.users[role].organizationId &&
            observation.collectionId === collection.collectionId &&
            observation.generationId === collection.generationId &&
            observation.configurationRevision === 1 &&
            observation.status === 'ACTIVE' &&
            observation.modelIdentity === LOAD_IDENTITY.weights &&
            observation.dimensions === 768 &&
            observation.chunkerVersion === 'token-window-utf8-v1' &&
            observation.parentContextVersion === 'parent-context-utf8-v1' &&
            observation.profileMatches === true &&
            observation.endpointIsOwned === true &&
            observation.quiescent === true &&
            observation.allCanonicalGeometryVerified === true &&
            observation.allPreparedInputHashesVerified === true &&
            observation.allPhysicalManifestRowsVerified === true &&
            observation.activeSourceVersionTuplesVerified === true,
        'LOAD_INDEPENDENT_PROOF'
    );
    need(
        Array.isArray(observation.publications) &&
            observation.publications.length === bindings.length &&
            new Set(observation.publications.map((pub) => pub.documentId))
                .size === bindings.length,
        'LOAD_PUBLICATION_PROOF'
    );
    let children = 0,
        parents = 0;
    bindings.forEach((binding, index) => {
        const doc = descriptors[index],
            pub = observation.publications.find(
                (pub) => pub.documentId === binding.documentId
            );
        need(
            pub?.versionId === binding.versionId &&
                pub.version === 1 &&
                pub.originalSha256 === doc.originalSha256 &&
                pub.canonicalSha256 === doc.canonicalSha256 &&
                Number.isSafeInteger(pub.childCount) &&
                pub.childCount > 0 &&
                pub.childCount <= 500 &&
                Number.isSafeInteger(pub.parentCount) &&
                pub.parentCount > 0 &&
                pub.parentCount <= 500 &&
                hash(pub.geometrySha256) &&
                hash(pub.preparedInputHashesSha256),
            'LOAD_PUBLICATION_PROOF'
        );
        if (doc.expectedGeometrySha256)
            need(
                pub.geometrySha256 === doc.expectedGeometrySha256 &&
                    pub.childCount === 500 &&
                    pub.parentCount === 125,
                'LOAD_PUBLICATION_PROOF'
            );
        children += pub.childCount;
        parents += pub.parentCount;
    });
    need(
        observation.physicalChildren === children &&
            observation.parents === parents &&
            (expectedChildren === null || children === expectedChildren) &&
            (expectedParents === null || parents === expectedParents),
        'LOAD_PHYSICAL_COUNT'
    );
    const usage = observation.usage;
    need(
        Number.isSafeInteger(usage?.validatedNativeVectors) &&
            usage.validatedNativeVectors === children &&
            usage.retries === 0 &&
            usage.errors === 0 &&
            (usage.providerInputTokens === null ||
                (typeof usage.providerInputTokens === 'string' &&
                    /^(?:0|[1-9][0-9]{0,18})$/u.test(
                        usage.providerInputTokens
                    ))),
        'LOAD_NATIVE_WORK_PROOF'
    );
    const native = usage.nativeWorkProof;
    need(
        Object.keys(native ?? {})
            .sort()
            .join(',') ===
            'baselineSha256,exclusive,finalSha256,kind,knownGapReports,nativeBatchErrors,nativeBatches,nativeFinishedBatches,nativeStartedBatches,producerIdentitySha256,receiptSha256,stableFinal' &&
            native?.kind === 'EXCLUSIVE_INDEXING_DELTA' &&
            native.baselineSha256 === nativeBaseline.baselineSha256 &&
            native.producerIdentitySha256 ===
                nativeBaseline.producerIdentitySha256 &&
            hash(native.finalSha256) &&
            hash(native.receiptSha256) &&
            native.stableFinal === true &&
            native.exclusive === true &&
            native.knownGapReports === '0' &&
            Number.isSafeInteger(native.nativeBatches) &&
            native.nativeBatches >= (children === 0 ? 0 : 1) &&
            native.nativeBatches <= children &&
            native.nativeStartedBatches === native.nativeBatches &&
            native.nativeFinishedBatches === native.nativeBatches &&
            native.nativeBatchErrors === 0 &&
            (expectedNativeWorkProof === null ||
                same(native, expectedNativeWorkProof)),
        'LOAD_NATIVE_WORK_PROOF'
    );
    need(
        Buffer.byteLength(JSON.stringify(native)) <= 2048,
        'LOAD_NATIVE_WORK_PROOF'
    );
    return {
        physicalChildren: children,
        parents,
        validatedNativeVectors: usage.validatedNativeVectors,
        retries: usage.retries,
        errors: usage.errors,
        providerInputTokens: usage.providerInputTokens,
        manifestSha256: observation.manifestSha256,
        nativeWorkProof: structuredClone(native),
    };
}
/** Fresh collections can remain BUILDING after durable task failure; never wait the full native budget. */
async function requireNoFailedWork(ctx, role, collection) {
    let offset = 0;
    do {
        const tasks = await ctx.call(role, 'indexing.tasks', {
            collectionId: collection.collectionId,
            offset,
            limit: 100,
            query: 'FAILED',
        });
        need(
            Number.isSafeInteger(tasks.total) &&
                tasks.total >= 0 &&
                tasks.total <= LOAD_LIMITS.documents + 1 &&
                Array.isArray(tasks.items) &&
                tasks.items.length === Math.min(100, tasks.total - offset),
            'LOAD_TASK_HISTORY'
        );
        need(
            !tasks.items.some(
                (task) =>
                    task.generationId === collection.generationId &&
                    (task.status === 'FAILED' || task.stage === 'FAILED')
            ),
            'LOAD_INDEX_FAILED'
        );
        offset += tasks.items.length;
        if (offset >= tasks.total) return;
    } while (true);
}
export async function startCollection(
    ctx,
    role,
    collection,
    bindings,
    descriptors,
    {
        observeGeneration,
        beginIndexObservation,
        expectedChildren,
        expectedParents,
        budgetMs,
        absoluteDeadline = ctx.started + LOAD_LIMITS.overallMs,
    }
) {
    need(
        typeof observeGeneration === 'function' &&
            typeof beginIndexObservation === 'function',
        'LOAD_OBSERVER_REQUIRED'
    );
    need(ctx.time() < absoluteDeadline, 'LOAD_PHASE_DEADLINE');
    const probe = await probeCollection(ctx, role, collection);
    const nativeBaseline = validateNativeBaseline(
        await beginIndexObservation({
            runId: ctx.state.runId,
            organizationId: ctx.fixture.users[role].organizationId,
            collectionId: collection.collectionId,
            configurationRevision: 1,
            expectedChildren,
            nativeIdentity: probe.digest,
            dimensions: probe.dimensions,
        }),
        ctx,
        role,
        collection
    );
    const indexStart = ctx.time();
    need(indexStart < absoluteDeadline, 'LOAD_PHASE_DEADLINE');
    const accepted = await ctx.mutate(
        role,
        'indexing.start',
        {
            collectionId: collection.collectionId,
            expectedRevision: 1,
            requestId: requestId(),
        },
        (value) => {
            need(id(value.generationId), 'LOAD_GENERATION_BINDING');
            return {
                collectionId: collection.collectionId,
                generationId: value.generationId,
            };
        }
    );
    collection = { ...collection, generationId: accepted.generationId };
    const status = await ctx.wait(
        async () => {
            const status = await ctx.call(role, 'indexing.status', {
                collectionId: collection.collectionId,
            });
            await requireNoFailedWork(ctx, role, collection);
            return status;
        },
        (value) => {
            need(
                value.configurationRevision === 1 &&
                    value.deletedAt === null &&
                    value.unsupportedReason === null &&
                    value.canRead === true &&
                    value.canManage === true,
                'LOAD_INDEX_ACCESS'
            );
            need(
                !value.generations.some(
                    (row) =>
                        row.id === collection.generationId &&
                        row.status === 'FAILED'
                ),
                'LOAD_INDEX_FAILED'
            );
            return (
                value.active?.id === collection.generationId &&
                value.active.status === 'ACTIVE'
            );
        },
        Math.min(indexStart + budgetMs, absoluteDeadline)
    );
    const elapsed = ctx.time() - indexStart;
    need(
        status.active.modelIdentity === LOAD_IDENTITY.weights &&
            status.active.dimensions === 768 &&
            status.active.totalDocuments === bindings.length &&
            status.active.publishedDocuments === bindings.length &&
            (expectedChildren === null ||
                status.active.projectedChunks === expectedChildren) &&
            status.usage.activeLimit === 100000 &&
            status.usage.temporaryLimit === 100000 &&
            status.usage.retainedChunks === 0 &&
            status.usage.reservedChunks === 0,
        'LOAD_ACTIVE_STATUS'
    );
    const observed = await observeGeneration({
        organizationId: ctx.fixture.users[role].organizationId,
        collectionId: collection.collectionId,
        generationId: collection.generationId,
        bindings: structuredClone(bindings),
        descriptors: descriptors.map(({ canonicalText, ...rest }) => rest),
        expectedChildren,
        expectedParents,
        nativeBaseline: structuredClone(nativeBaseline),
        expectedNativeWorkProof: null,
    });
    const proof = validateGenerationObservation(observed, {
        ctx,
        role,
        collection,
        bindings,
        descriptors,
        expectedChildren,
        expectedParents,
        nativeBaseline,
    });
    need(
        status.active.projectedChunks === proof.physicalChildren &&
            hash(observed.manifestSha256),
        'LOAD_ACTIVE_STATUS'
    );
    return {
        ...collection,
        activeChildren: proof.physicalChildren,
        parents: proof.parents,
        indexMs: elapsed,
        nativeBaseline,
        observation: proof,
    };
}
export async function verifyCollection(
    ctx,
    role,
    collection,
    bindings,
    descriptors,
    observeGeneration
) {
    const saved = await ctx.call(role, 'collections.get', {
        id: collection.collectionId,
    });
    need(
        saved.configurationRevision === 1 &&
            saved.permissions?.read === true &&
            saved.permissions.manageDocuments === true &&
            saved.permissions.administer === true &&
            Object.entries(collection.profile).every(([key, value]) =>
                same(saved.configuration?.[key], value)
            ),
        'LOAD_SAVED_PROFILE'
    );
    const status = await ctx.call(role, 'indexing.status', {
        collectionId: collection.collectionId,
    });
    need(
        status.canRead === true &&
            status.canManage === true &&
            status.active?.id === collection.generationId &&
            status.active.status === 'ACTIVE' &&
            status.configurationRevision === 1 &&
            status.active.projectedChunks === collection.activeChildren &&
            status.usage.reservedChunks === 0 &&
            status.usage.retainedChunks === 0,
        'LOAD_BASELINE_CHANGED'
    );
    const nativeBaseline = validateNativeBaseline(
        collection.nativeBaseline,
        ctx,
        role,
        collection
    );
    need(collection.observation?.nativeWorkProof, 'LOAD_NATIVE_WORK_PROOF');
    const observed = await observeGeneration({
        organizationId: ctx.fixture.users[role].organizationId,
        collectionId: collection.collectionId,
        generationId: collection.generationId,
        bindings: structuredClone(bindings),
        descriptors: descriptors.map(({ canonicalText, ...rest }) => rest),
        expectedChildren: collection.activeChildren,
        expectedParents: collection.parents,
        nativeBaseline: structuredClone(nativeBaseline),
        expectedNativeWorkProof: structuredClone(
            collection.observation.nativeWorkProof
        ),
    });
    validateGenerationObservation(observed, {
        ctx,
        role,
        collection,
        bindings,
        descriptors,
        expectedChildren: collection.activeChildren,
        expectedParents: collection.parents,
        nativeBaseline,
        expectedNativeWorkProof: collection.observation.nativeWorkProof,
    });
    return observed;
}
