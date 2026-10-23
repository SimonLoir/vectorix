/** Normal-API orchestration with injected transports. No filesystem/network/DB work on import. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
    sha256,
    resolvedFilters,
    validateFixtures,
    safeOffset,
} from './evaluate.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const STRATEGIES = ['DOCUMENT_STRUCTURE', 'TOKEN_WINDOW', 'SEMANTIC'];
const DENIED = new Set([403, 404]);
const READ_GRANT = { read: true, manageDocuments: false, administer: false };
const SAFE_CODES = new Set([
    'ACCESS_REVOKED',
    'FORBIDDEN',
    'NOT_FOUND',
    'UNAUTHORIZED',
    'BAD_REQUEST',
    'CONFLICT',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_REJECTED',
    'INVALID_PROVIDER_RESPONSE',
    'MODEL_CHANGED',
    'VECTOR_UNAVAILABLE',
    'STORAGE_UNAVAILABLE',
    'SOURCE_UNAVAILABLE',
    'QUOTA_EXCEEDED',
    'CHUNK_LIMIT',
    'TIMEOUT',
]);
export const COLLECTOR_LIMITS = Object.freeze({
    apiCalls: 6000,
    durationMs: 90 * 60 * 1000,
    phaseWaitMs: 20 * 60 * 1000,
    responseBytes: 2 * 1024 * 1024,
    captureBytes: 8 * 1024 * 1024,
    passages: 2048,
    sourceSegments: 64,
});
export class CollectorInvariantError extends Error {}
export const fail = (label) => {
    throw new CollectorInvariantError(label);
};
const require = (condition, label) => {
    if (!condition) fail(label);
};
const clone = (value) => structuredClone(value);

/** Bootstrap identities are supplied separately by the reviewed disposable setup, never inferred from sessions. */
export function validateBootstrap(value, state) {
    require(value.schemaVersion === 1 &&
        value.namespace === 'vectorix-m7c-quality' &&
        value.runId === state.runId, 'BOOTSTRAP_BINDING');
    require(Object.keys(value.users).sort().join(',') ===
        'foreign,owner,reader', 'BOOTSTRAP_ROLES');
    require(Array.isArray(value.organizationIds) &&
        value.organizationIds.length === 2 &&
        new Set(value.organizationIds).size === 2 &&
        value.organizationIds.every((id) =>
            ID.test(id)
        ), 'BOOTSTRAP_ORGANIZATIONS');
    for (const [role, user] of Object.entries(value.users)) {
        require(ID.test(user.userId) &&
            ID.test(user.memberId) &&
            value.organizationIds.includes(
                user.organizationId
            ), 'BOOTSTRAP_USER_IDS');
        require(user.email ===
            `m7c-quality-${role}-${state.runId}@example.test` &&
            typeof user.password === 'string' &&
            user.password.length >= 20 &&
            user.password.length <= 200, 'BOOTSTRAP_SYNTHETIC_CREDENTIALS');
    }
    require(new Set(Object.values(value.users).map((user) => user.userId))
        .size === 3 &&
        new Set(Object.values(value.users).map((user) => user.memberId))
            .size === 3, 'BOOTSTRAP_DISTINCT_USERS');
    require(value.users.owner.organizationId ===
        value.users.reader.organizationId &&
        value.users.owner.organizationId !==
            value.users.foreign.organizationId, 'BOOTSTRAP_MEMBERSHIPS');
    return value;
}

export function profileFor(fixtures, strategy) {
    require(STRATEGIES.includes(strategy), 'UNKNOWN_CHUNK_STRATEGY');
    const p = fixtures.policy.profile,
        m = fixtures.policy.model;
    return {
        provider: m.provider,
        model: m.model,
        dimensions: m.dimensions,
        embeddingPreset: m.preset,
        metric: 'cosine',
        indexType: p.indexType,
        numericType: 'float32',
        preparation: p.preparation,
        metadataFields: clone(fixtures.manifest.metadataFields),
        chunkingStrategy: strategy,
        parentChild: true,
        chunking: Object.fromEntries(
            [
                'targetTokens',
                'minTokens',
                'maxTokens',
                'overlapTokens',
                'parentMaxTokens',
                'semanticPercentile',
            ].map((key) => [key, p[key]])
        ),
    };
}

/** Only public provenance fields enter a passage; receipts, scores, vectors and arbitrary extensions are dropped. */
export function capturePassage(result, { document, profile, organizationId }) {
    require(result &&
        ID.test(result.id) &&
        ID.test(result.publicationId) &&
        result.documentId === document.documentId &&
        result.version === document.version &&
        result.generationId === profile.generationId, 'RESULT_BINDING');
    require(typeof result.text === 'string' &&
        result.text.length <= 49152 &&
        Array.isArray(result.sourceSpans) &&
        result.sourceSpans.length <= 64 &&
        typeof result.sourceSpansTruncated ===
            'boolean', 'RESULT_PROVENANCE_BOUND');
    const parent = result.parentContext;
    require(parent &&
        ID.test(parent.id) &&
        Number.isSafeInteger(parent.ordinal) &&
        parent.ordinal >= 0 &&
        Number.isSafeInteger(parent.tokenCount) &&
        parent.tokenCount > 0 &&
        typeof parent.tokenCountIsEstimate === 'boolean' &&
        typeof parent.text === 'string' &&
        parent.text.length <= 49152 &&
        Array.isArray(parent.sourceSpans) &&
        parent.sourceSpans.length <= 64 &&
        typeof parent.sourceSpansTruncated ===
            'boolean', 'PARENT_PROVENANCE_BOUND');
    const parentContext = Object.fromEntries(
        [
            'id',
            'ordinal',
            'text',
            'startOffset',
            'endOffset',
            'tokenCount',
            'tokenCountIsEstimate',
            'sourceSpans',
            'sourceSpansTruncated',
        ].map((key) => [key, clone(parent[key])])
    );
    return {
        id: result.id,
        fixtureId: document.fixtureId,
        chunkStrategy: profile.chunkStrategy,
        organizationId,
        collectionId: profile.collectionId,
        generationId: result.generationId,
        publicationId: result.publicationId,
        documentId: result.documentId,
        version: result.version,
        language: result.language,
        mediaType: result.mediaType,
        metadata: clone(result.metadata),
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        text: result.text,
        sourceSpans: clone(result.sourceSpans),
        sourceSpansTruncated: result.sourceSpansTruncated,
        parentContext,
    };
}
export function safeFailure(error) {
    const code = error?.data?.errorCode ?? error?.code;
    return SAFE_CODES.has(code) ? code : 'REQUEST_FAILED';
}
const statusOf = (error) =>
    Number.isInteger(error?.status) ? error.status : 0;

/** Run a fixed matrix through supported APIs; source probes are declared separately and never scored. */
export async function collectQuality({
    fixtures,
    state,
    bootstrap,
    api,
    originalBytes,
    observeGeneration,
    sleep,
    now = Date.now,
    checkpoint = async () => {},
    evidenceKind = 'LIVE_NATIVE_ISOLATED',
}) {
    validateFixtures(fixtures);
    validateBootstrap(bootstrap, state);
    require(['LIVE_NATIVE_ISOLATED', 'SYNTHETIC_UNIT_TEST'].includes(
        evidenceKind
    ), 'COLLECTOR_EVIDENCE_KIND');
    const organizationId = bootstrap.users.owner.organizationId,
        started = now();
    let calls = 0,
        estimatedBytes = 2048;
    const capture = {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        corpusDigest: fixtures.manifest.corpusDigest,
        evidenceKind,
        organizationId,
        documents: [],
        profiles: [],
        sourceProofs: [],
        passages: [],
        runs: [],
        accessChecks: [],
        collectionEvidence: {
            status: 'IN_PROGRESS',
            recordedRagRpcCalls: 0,
            unscoredSourceProbeAttempts: 0,
            unscoredSourceProbeSuccesses: 0,
            scoredQueryAttempts: 0,
            generationObservation: 'GUARDED_READ_ONLY_PRISMA_SEPARATE_FROM_API',
            canonicalEvidence:
                'LIBRARY_CURRENT_V1_FULL_PREVIEW_PLUS_ALL_INDEXED_SOURCE_SEGMENTS',
            performanceAcceptance: 'NOT_RUN',
        },
    };
    const docsById = new Map(),
        passageMap = new Map(),
        observations = new Map();
    function append(field, row) {
        estimatedBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        require(estimatedBytes <=
            COLLECTOR_LIMITS.captureBytes, 'CAPTURE_BYTE_CAP');
        capture[field].push(row);
    }
    async function call(role, operation, input) {
        require(now() - started <= COLLECTOR_LIMITS.durationMs &&
            ++calls <= COLLECTOR_LIMITS.apiCalls, 'COLLECTOR_BUDGET_EXHAUSTED');
        capture.collectionEvidence.recordedRagRpcCalls = calls;
        return await api.call(role, operation, input);
    }
    const store = async () => {
        require(Buffer.byteLength(JSON.stringify(capture)) <=
            COLLECTOR_LIMITS.captureBytes, 'CAPTURE_ACTUAL_BYTE_CAP');
        await checkpoint(clone(capture));
    };
    async function waitUntil(read, ready, label) {
        const deadline = Math.min(
            started + COLLECTOR_LIMITS.durationMs,
            now() + COLLECTOR_LIMITS.phaseWaitMs
        );
        while (now() <= deadline) {
            const value = await read();
            if (ready(value)) return value;
            await sleep(2000);
        }
        fail(label);
    }
    function addPassage(result, profile) {
        const binding = docsById.get(result.documentId);
        require(binding, 'UNKNOWN_RESULT_DOCUMENT');
        const reference = fixtures.manifest.documents.find(
            (row) => row.fixtureId === binding.fixtureId
        );
        const artifact = fixtures.artifacts[binding.fixtureId];
        require(result.language === reference.language &&
            result.mediaType === reference.mediaType &&
            isDeepStrictEqual(
                result.metadata,
                reference.metadata
            ), 'RESULT_FROZEN_METADATA');
        for (const row of [result, result.parentContext]) {
            require(row &&
                safeOffset(artifact.text, row.startOffset) &&
                safeOffset(artifact.text, row.endOffset) &&
                row.endOffset > row.startOffset &&
                row.text ===
                    artifact.text.slice(
                        row.startOffset,
                        row.endOffset
                    ), 'RESULT_CANONICAL_TEXT');
            const spans = artifact.sources.flatMap((source) => {
                const start = Math.max(source.start, row.startOffset),
                    end = Math.min(source.end, row.endOffset);
                return start < end ? [{ source, start, end }] : [];
            });
            require(isDeepStrictEqual(row.sourceSpans, spans.slice(0, 64)) &&
                row.sourceSpansTruncated ===
                    spans.length > 64, 'RESULT_CANONICAL_PROVENANCE');
        }
        const passage = capturePassage(result, {
            document: binding,
            profile,
            organizationId,
        });
        const previous = passageMap.get(passage.id);
        if (previous)
            require(isDeepStrictEqual(
                previous,
                passage
            ), 'PASSAGE_CHANGED_DURING_CAPTURE');
        else {
            require(passageMap.size <
                COLLECTOR_LIMITS.passages, 'PASSAGE_COUNT_CAP');
            passageMap.set(passage.id, passage);
            append('passages', passage);
        }
        return passage;
    }
    const freshDocs = await call('owner', 'documents.list', {
        offset: 0,
        limit: 100,
        query: '',
    });
    const freshCollections = await call('owner', 'collections.list', {
        offset: 0,
        limit: 100,
        query: '',
    });
    require(freshDocs.total === 0 &&
        freshCollections.total === 0, 'QUALITY_ORGANIZATION_MUST_BE_FRESH');
    try {
        for (const document of fixtures.manifest.documents) {
            const bytes = await originalBytes(document);
            require(bytes instanceof Uint8Array &&
                bytes.byteLength === document.originalBytes &&
                sha256(bytes) === document.originalSha256 &&
                bytes.byteLength <=
                    COLLECTOR_LIMITS.responseBytes, 'ORIGINAL_FIXTURE_HASH');
            const uploaded = await call('owner', 'documents.upload', {
                requestId: randomUUID(),
                file: new File([bytes], document.fileName, {
                    type: document.mediaType,
                }),
            });
            require(ID.test(uploaded.id) &&
                ID.test(uploaded.versionId) &&
                !docsById.has(uploaded.id), 'UPLOAD_BINDING');
            const binding = {
                fixtureId: document.fixtureId,
                documentId: uploaded.id,
                version: document.version,
                originalSha256: document.originalSha256,
                canonicalSha256: document.canonicalSha256,
            };
            append('documents', binding);
            docsById.set(binding.documentId, binding);
            await store();
        }
        await waitUntil(
            async () =>
                await call('owner', 'documents.list', {
                    offset: 0,
                    limit: 100,
                    query: '',
                }),
            (page) => {
                require(page.total === 24 &&
                    page.items.length === 24 &&
                    page.items.every((row) =>
                        docsById.has(row.id)
                    ), 'DOCUMENT_CATALOG_CHANGED');
                require(!page.items.some((row) =>
                    ['FAILED', 'DELETED'].includes(row.status)
                ), 'DOCUMENT_EXTRACTION_FAILED');
                return page.items.every((row) => row.status === 'READY');
            },
            'DOCUMENT_EXTRACTION_WAIT_EXHAUSTED'
        );
        // Full canonical text is observed through the normal library API while all publications remain v1.
        const canonicalProofs = new Map();
        for (const binding of capture.documents) {
            const doc = fixtures.manifest.documents.find(
                (row) => row.fixtureId === binding.fixtureId
            );
            const details = await call('owner', 'documents.details', {
                id: binding.documentId,
            });
            require(details.version?.version === 1 &&
                details.version.status === 'READY', 'LIBRARY_VERSION_CHANGED');
            const preview = await call('owner', 'documents.preview', {
                id: binding.documentId,
                offset: 0,
            });
            require(preview.version === 1 &&
                preview.nextOffset === null &&
                preview.totalCharacters ===
                    fixtures.artifacts[doc.fixtureId].text.length &&
                sha256(preview.text) ===
                    doc.canonicalSha256, 'FULL_LIBRARY_CANONICAL_PROOF');
            canonicalProofs.set(doc.fixtureId, {
                versionId: details.version.id,
                canonicalSha256: sha256(preview.text),
            });
        }
        for (const strategy of fixtures.policy.strategies) {
            const collection = await call('owner', 'collections.create', {
                name: `M7c ${state.runId} ${strategy}`,
                description:
                    'Frozen artificial reference corpus; quality acceptance only.',
                grantCreatorRead: true,
                profile: profileFor(fixtures, strategy),
            });
            require(ID.test(collection.id) &&
                collection.configurationRevision === 1, 'COLLECTION_BINDING');
            const requestedProfile = profileFor(fixtures, strategy);
            require(Object.entries(requestedProfile).every(([key, value]) =>
                isDeepStrictEqual(collection.configuration[key], value)
            ), 'SAVED_COLLECTION_PROFILE');
            for (const binding of capture.documents) {
                const doc = fixtures.manifest.documents.find(
                    (row) => row.fixtureId === binding.fixtureId
                );
                await call('owner', 'documents.setCollection', {
                    id: binding.documentId,
                    collectionId: collection.id,
                    attached: true,
                });
                await call('owner', 'indexing.updateMetadata', {
                    collectionId: collection.id,
                    documentId: binding.documentId,
                    expectedMetadataRevision: 1,
                    language: doc.language,
                    tags: clone(doc.tags),
                    metadata: clone(doc.metadata),
                });
            }
            const metadata = await call('owner', 'indexing.documents', {
                collectionId: collection.id,
                offset: 0,
                limit: 100,
                query: '',
            });
            require(metadata.total === 24 &&
                metadata.items.length === 24, 'ASSOCIATION_COUNT');
            for (const binding of capture.documents) {
                const expected = fixtures.manifest.documents.find(
                        (row) => row.fixtureId === binding.fixtureId
                    ),
                    saved = metadata.items.find(
                        (row) => row.documentId === binding.documentId
                    );
                require(saved &&
                    saved.language === expected.language &&
                    isDeepStrictEqual(saved.tags, expected.tags) &&
                    isDeepStrictEqual(
                        saved.metadata,
                        expected.metadata
                    ), 'ASSOCIATION_METADATA_NOT_SAVED');
            }
            const probe = await call('owner', 'indexing.probe', {
                collectionId: collection.id,
                expectedRevision: 1,
            });
            require(probe.provider === 'OLLAMA' &&
                probe.model === fixtures.policy.model.model &&
                probe.digest === fixtures.policy.model.digest &&
                probe.dimensions === 768 &&
                probe.preset === 'EMBEDDING_GEMMA' &&
                probe.identityKind ===
                    'WEIGHTS_DIGEST', 'NATIVE_PROBE_IDENTITY');
            const accepted = await call('owner', 'indexing.start', {
                collectionId: collection.id,
                expectedRevision: 1,
                requestId: randomUUID(),
            });
            const status = await waitUntil(
                async () => {
                    const value = await call('owner', 'indexing.status', {
                        collectionId: collection.id,
                    });
                    require(value.unsupportedReason === null &&
                        value.configurationRevision ===
                            1, 'INDEX_PROFILE_OR_REVISION_CHANGED');
                    if (value.active?.id !== accepted.generationId) {
                        const tasks = await call('owner', 'indexing.tasks', {
                            collectionId: collection.id,
                            offset: 0,
                            limit: 100,
                            query: '',
                        });
                        require(tasks.total <= 100 &&
                            !tasks.items.some(
                                (task) =>
                                    task.generationId ===
                                        accepted.generationId &&
                                    ['FAILED', 'CANCELLED'].includes(
                                        task.status
                                    )
                            ), 'INDEX_EXECUTION_FAILED');
                    }
                    return value;
                },
                (value) =>
                    value.active?.id === accepted.generationId &&
                    value.active.status === 'ACTIVE',
                'INDEX_ACTIVATION_WAIT_EXHAUSTED'
            );
            const observed = await observeGeneration({
                organizationId,
                collectionId: collection.id,
                generationId: accepted.generationId,
            });
            require(observed.organizationId === organizationId &&
                observed.collectionId === collection.id &&
                observed.generationId === accepted.generationId &&
                observed.configurationRevision === 1 &&
                observed.modelIdentity === fixtures.policy.model.digest &&
                observed.modelIdentity === status.active.modelIdentity &&
                observed.parentContextVersion ===
                    status.active.parentContextVersion &&
                observed.model === probe.model &&
                observed.dimensions === probe.dimensions &&
                observed.embeddingPreset === probe.preset &&
                observed.contextTokens === probe.contextTokens &&
                observed.endpointIsOwned === true &&
                /^[a-f0-9]{64}$/u.test(
                    observed.capabilitySnapshotSha256
                ), 'SAVED_GENERATION_PROOF');
            require(observed.publications.length === 24 &&
                new Set(observed.publications.map((row) => row.documentId))
                    .size === 24, 'SAVED_PUBLICATION_COUNT');
            for (const binding of capture.documents) {
                const published = observed.publications.find(
                    (row) => row.documentId === binding.documentId
                );
                require(published &&
                    ID.test(published.id) &&
                    published.version === 1 &&
                    published.originalSha256 === binding.originalSha256 &&
                    published.sourceVersionId ===
                        canonicalProofs.get(binding.fixtureId)
                            .versionId, 'SAVED_PUBLICATION_VERSION');
            }
            const expectedSavedProfile = Object.fromEntries(
                Object.entries(fixtures.policy.profile).filter(
                    ([key]) => key !== 'maxEmbeddingInputBytes'
                )
            );
            require(isDeepStrictEqual(
                observed.profile,
                expectedSavedProfile
            ), 'SAVED_GENERATION_PROFILE');
            const profile = {
                chunkStrategy: strategy,
                organizationId,
                collectionId: collection.id,
                generationId: accepted.generationId,
                chunkerVersion: observed.chunkerVersion,
                parentContextVersion: observed.parentContextVersion,
                model: clone(fixtures.policy.model),
                profile: clone(observed.profile),
                commit: state.commit,
                savedIdentitySha256: observed.capabilitySnapshotSha256,
            };
            append('profiles', profile);
            observations.set(strategy, observed);
            await store();
        }
        // Receipt TTL is respected: each unscored probe is followed immediately by source reads/download.
        for (const profile of capture.profiles)
            for (const binding of capture.documents) {
                const doc = fixtures.manifest.documents.find(
                        (row) => row.fixtureId === binding.fixtureId
                    ),
                    artifact = fixtures.artifacts[doc.fixtureId];
                const primary = doc.goldSpans.find(
                    (row) => row.anchorId === 'primary'
                );
                const query = artifact.text.slice(
                    primary.startOffset,
                    primary.endOffset
                );
                capture.collectionEvidence.unscoredSourceProbeAttempts++;
                const response = await call('owner', 'indexing.search', {
                    collectionId: profile.collectionId,
                    query,
                    strategy: 'LEXICAL',
                    topK: 1,
                    filters: { documentIds: [binding.documentId] },
                });
                require(response.generationId === profile.generationId &&
                    response.results.length ===
                        1, 'EXACT_SOURCE_PROBE_NO_MATCH');
                const result = response.results[0],
                    published = observations
                        .get(profile.chunkStrategy)
                        .publications.find(
                            (row) => row.documentId === binding.documentId
                        );
                require(result.documentId === binding.documentId &&
                    result.publicationId === published.id &&
                    result.version === 1 &&
                    typeof result.source?.receipt ===
                        'string', 'EXACT_SOURCE_PROBE_BINDING');
                addPassage(result, profile);
                let returnedCharacters = 0;
                require(artifact.sources.length <=
                    COLLECTOR_LIMITS.sourceSegments, 'REFERENCE_SOURCE_SEGMENT_CAP');
                for (const source of artifact.sources) {
                    const preview = await call(
                        'owner',
                        'indexing.sourcePreview',
                        {
                            collectionId: profile.collectionId,
                            receipt: result.source.receipt,
                            sourceIndex: source.index,
                            offset: 0,
                        }
                    );
                    require(preview.version === 1 &&
                        preview.nextOffset === null &&
                        preview.totalSources === artifact.sources.length &&
                        isDeepStrictEqual(preview.source, source) &&
                        preview.text ===
                            artifact.text.slice(source.start, source.end) &&
                        preview.totalCharacters ===
                            source.end -
                                source.start, 'EXACT_INDEXED_SEGMENT_PROOF');
                    returnedCharacters += preview.text.length;
                }
                const original = await call(
                    'owner',
                    'indexing.sourceOriginal',
                    {
                        collectionId: profile.collectionId,
                        receipt: result.source.receipt,
                    }
                );
                require(typeof original?.arrayBuffer === 'function' &&
                    original.size === doc.originalBytes &&
                    original.size <=
                        COLLECTOR_LIMITS.responseBytes, 'EXACT_ORIGINAL_SIZE');
                require(api.observedStatus('owner') ===
                    200, 'EXACT_ORIGINAL_HTTP_STATUS');
                const digest = sha256(
                    new Uint8Array(await original.arrayBuffer())
                );
                require(digest === doc.originalSha256, 'EXACT_ORIGINAL_HASH');
                append('sourceProofs', {
                    id: `${profile.chunkStrategy}/${doc.fixtureId}`,
                    fixtureId: doc.fixtureId,
                    documentId: binding.documentId,
                    version: 1,
                    organizationId,
                    collectionId: profile.collectionId,
                    generationId: profile.generationId,
                    publicationId: result.publicationId,
                    httpStatus: api.observedStatus('owner'),
                    originalSha256: digest,
                    canonicalSha256: canonicalProofs.get(doc.fixtureId)
                        .canonicalSha256,
                    canonicalEvidence: {
                        method: 'LIBRARY_CURRENT_V1_FULL_PREVIEW_PLUS_INDEXED_SEGMENTS',
                        indexedSegments: artifact.sources.length,
                        returnedSegmentCharacters: returnedCharacters,
                        referenceGapCharactersNotReturnedByIndexedPreview:
                            artifact.text.length - returnedCharacters,
                    },
                });
                capture.collectionEvidence.unscoredSourceProbeSuccesses++;
                await store();
            }
        const bindingMap = new Map(
            capture.documents.map((row) => [row.fixtureId, row])
        );
        for (const profile of capture.profiles)
            for (const mode of fixtures.policy.modes)
                for (let repeat = 1; repeat <= 2; repeat++)
                    for (const query of fixtures.queries) {
                        const input = {
                            collectionId: profile.collectionId,
                            query: query.text,
                            topK: 10,
                            strategy: mode,
                            filters: resolvedFilters(query, bindingMap),
                        };
                        const run = {
                            queryId: query.id,
                            chunkStrategy: profile.chunkStrategy,
                            searchStrategy: mode,
                            repeat,
                            status: 'SUCCESS',
                            querySha256: sha256(query.text),
                            filters: clone(input.filters),
                            topK: 10,
                            organizationId,
                            collectionId: profile.collectionId,
                            generationId: profile.generationId,
                            model: fixtures.policy.model.model,
                            results: [],
                            parentUnderfilled: null,
                            vectorUnderfilled: null,
                        };
                        capture.collectionEvidence.scoredQueryAttempts++;
                        try {
                            const response = await call(
                                'owner',
                                'indexing.search',
                                input
                            );
                            require(response.generationId ===
                                profile.generationId &&
                                response.model ===
                                    fixtures.policy.model.model &&
                                response.strategy === mode &&
                                response.results.length <=
                                    10, 'QUERY_RESPONSE_BINDING');
                            run.results = response.results.map(
                                (result) => addPassage(result, profile).id
                            );
                            run.parentUnderfilled = response.parentUnderfilled;
                            run.vectorUnderfilled = response.vectorUnderfilled;
                        } catch (error) {
                            if (error instanceof CollectorInvariantError)
                                throw error;
                            run.status = 'ERROR';
                            run.errorCode = safeFailure(error);
                            run.results = [];
                        }
                        append('runs', run);
                        await store();
                    }
        for (const profile of capture.profiles) {
            const first = capture.documents[0],
                query = fixtures.queries[0].text;
            const input = {
                collectionId: profile.collectionId,
                query,
                strategy: 'LEXICAL',
                topK: 1,
                filters: { documentIds: [first.documentId] },
            };
            await call('owner', 'collections.setGrant', {
                id: profile.collectionId,
                target: { type: 'member', id: bootstrap.users.reader.memberId },
                permissions: READ_GRANT,
            });
            const read = await call('reader', 'indexing.search', input);
            require(read.generationId === profile.generationId &&
                read.model === fixtures.policy.model.model &&
                read.strategy === 'LEXICAL' &&
                api.observedStatus('reader') === 200 &&
                read.results.length === 1 &&
                read.results[0].documentId === first.documentId &&
                read.results[0].version === 1 &&
                typeof read.results[0].source?.receipt ===
                    'string', 'READER_CONTROL_NO_RECEIPT');
            addPassage(read.results[0], profile);
            append('accessChecks', {
                chunkStrategy: profile.chunkStrategy,
                kind: 'CURRENT_READER_ALLOWED',
                httpStatus: api.observedStatus('reader'),
                returnedFixtureIds: read.results.map(
                    (result) =>
                        docsById.get(result.documentId)?.fixtureId ?? 'UNKNOWN'
                ),
            });
            const receipt = read.results[0].source.receipt;
            async function denied(role, kind, operation, request) {
                let status = 200,
                    returned = [];
                try {
                    const output = await call(role, operation, request);
                    returned =
                        operation === 'indexing.sourcePreview'
                            ? [first.fixtureId]
                            : (output.results ?? []).map(
                                  (row) =>
                                      docsById.get(row.documentId)?.fixtureId ??
                                      'UNKNOWN'
                              );
                } catch (error) {
                    status = api.observedStatus(role) ?? statusOf(error);
                }
                append('accessChecks', {
                    chunkStrategy: profile.chunkStrategy,
                    kind,
                    httpStatus: status,
                    returnedFixtureIds: returned,
                });
                return DENIED.has(status);
            }
            await denied(
                'foreign',
                'FOREIGN_ORGANIZATION_DENIED',
                'indexing.search',
                input
            );
            await call('owner', 'collections.removeGrant', {
                id: profile.collectionId,
                target: { type: 'member', id: bootstrap.users.reader.memberId },
            });
            await denied(
                'reader',
                'REVOKED_GRANT_DENIED',
                'indexing.search',
                input
            );
            await denied(
                'reader',
                'OLD_RECEIPT_AFTER_REVOCATION_DENIED',
                'indexing.sourcePreview',
                { collectionId: profile.collectionId, receipt, offset: 0 }
            );
            const final = await call('owner', 'indexing.status', {
                collectionId: profile.collectionId,
            });
            require(final.active?.id === profile.generationId &&
                final.configurationRevision ===
                    1, 'GENERATION_CHANGED_DURING_CAPTURE');
            await store();
        }
        require(capture.runs.length === 720 &&
            capture.sourceProofs.length === 72 &&
            capture.accessChecks.length === 12, 'CAPTURE_MATRIX_INCOMPLETE');
        capture.collectionEvidence.status = 'CAPTURED_NOT_YET_EVALUATED';
        await store();
        return capture;
    } catch (error) {
        capture.collectionEvidence.status = 'STOPPED_INCOMPLETE';
        capture.collectionEvidence.stoppedReason =
            error instanceof CollectorInvariantError
                ? error.message
                : safeFailure(error);
        await store();
        throw error;
    }
}
