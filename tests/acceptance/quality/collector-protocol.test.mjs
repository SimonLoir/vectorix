/** Offline mock protocol only; no HTTP, DB, S3, provider or container operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { loadFixtures, BASE } from './fixture-loader.mjs';
import { evaluateCapture, sha256 } from './evaluate.mjs';
import { replaceRange } from './synthetic-test-helper.mjs';
import {
    collectQuality,
    capturePassage,
    profileFor,
    validateBootstrap,
    safeFailure,
} from './collector-protocol.mjs';
import { validateQualityState } from './collector-state.mjs';
const fixtures = await loadFixtures(),
    runId = 'abcdef012345';
function bootstrap() {
    const users = Object.fromEntries(
        ['owner', 'reader', 'foreign'].map((role) => [
            role,
            {
                userId: role + '-user',
                memberId: role + '-member',
                organizationId: role === 'foreign' ? 'org-b' : 'org-a',
                email: `m7c-quality-${role}-${runId}@example.test`,
                password: 'synthetic-quality-password-294812!',
            },
        ])
    );
    return {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId,
        users,
        organizationIds: ['org-a', 'org-b'],
    };
}
function state() {
    const ports = {
        api: 3101,
        web: 3100,
        admin: 3006,
        postgres: 45001,
        vector: 45002,
        redis: 45003,
        rustfs: 45004,
        ollama: 45005,
    };
    const prefix = 'vectorix-m7c-quality-' + runId;
    return {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId,
        prefix,
        phase: 'READY_FOR_QUALITY_IMPORT',
        applicationDatabase: `vectorix_m7c_quality_app_${runId}_test`,
        vectorDatabase: `vectorix_m7c_quality_vectors_${runId}_test`,
        commit: '1'.repeat(40),
        lockfileSha256: '2'.repeat(64),
        ports,
        apiOrigin: 'http://127.0.0.1:3101',
        webOrigin: 'http://127.0.0.1:3100',
        resources: Object.fromEntries(
            ['postgres', 'vector', 'redis', 'rustfs', 'ollama'].map(
                (service, index) => [
                    service,
                    {
                        name: prefix + '-' + service,
                        id: String(index + 1).repeat(64),
                        imageId: 'sha256:' + 'b'.repeat(64),
                        volume:
                            service === 'ollama'
                                ? 'preserved-model-volume'
                                : prefix + '-' + service + '-data',
                        volumeIdentity: String(index + 4).repeat(64),
                    },
                ]
            )
        ),
        processes: Object.fromEntries(
            ['api', 'workers'].map((service) => [
                service,
                {
                    service,
                    pid: 123,
                    startTicks: '123',
                    bootId: 'a'.repeat(36),
                    entrySha256: 'd'.repeat(64),
                },
            ])
        ),
        environment: {
            NODE_ENV: 'production',
            DATABASE_URL: `postgresql://postgres:synthetic@127.0.0.1:45001/vectorix_m7c_quality_app_${runId}_test`,
            VECTOR_DATABASE_URL: `postgresql://runtime:synthetic@127.0.0.1:45002/vectorix_m7c_quality_vectors_${runId}_test`,
            VECTOR_DATABASE_PROVISIONING_URL: `postgresql://indexer:synthetic@127.0.0.1:45002/vectorix_m7c_quality_vectors_${runId}_test`,
            REDIS_URL: 'redis://127.0.0.1:45003',
            VECTORIX_DEFAULT_OLLAMA_ENDPOINT: 'http://127.0.0.1:45005',
            VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS: 'http://127.0.0.1:45005',
            VECTORIX_DEFAULT_OLLAMA_API_KEY: '',
            VECTORIX_DEFAULT_S3_ENDPOINT: 'http://127.0.0.1:45004',
            VECTORIX_S3_ALLOWED_ENDPOINTS: 'http://127.0.0.1:45004',
            VECTORIX_DEFAULT_S3_BUCKET: `m7c-quality-${runId}`,
            VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE: 'true',
            VECTORIX_DEFAULT_S3_REGION: 'us-east-1',
            VECTORIX_DEFAULT_S3_ACCESS_KEY_ID: 'synthetic',
            VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY: 'synthetic',
            BETTER_AUTH_URL: 'http://127.0.0.1:3101',
            API_URL: 'http://127.0.0.1:3101',
            VECTORIX_WEB_URL: 'http://127.0.0.1:3100',
            TRUSTED_ORIGINS: 'http://127.0.0.1:3100',
            VECTOR_DATABASE_SCHEMA: 'vector_collections',
            VECTORIX_WEB_PUSH_ENABLED: 'false',
        },
    };
}
async function mockProtocol(options = {}) {
    const statuses = new Map();
    const trace = [],
        uploaded = new Map(),
        collections = new Map(),
        receipts = new Map(),
        grants = new Map();
    const bytes = new Map(
        await Promise.all(
            fixtures.manifest.documents.map(async (doc) => [
                doc.fixtureId,
                new Uint8Array(await readFile(BASE + '/' + doc.originalPath)),
            ])
        )
    );
    function response(profile, docId) {
        const doc = uploaded.get(docId),
            artifact = fixtures.artifacts[doc.fixtureId],
            primary = doc.goldSpans[0];
        const row = {
            id: `chunk-${profile.strategy}-${doc.fixtureId}`,
            publicationId: `pub-${profile.strategy}-${doc.fixtureId}`,
            documentId: docId,
            version: 1,
            generationId: profile.generationId,
            language: doc.language,
            mediaType: doc.mediaType,
            metadata: structuredClone(doc.metadata),
            source: {
                receipt: `synthetic-secret-receipt-${profile.strategy}-${doc.fixtureId}`,
                expiresAt: new Date(Date.now() + 900000),
            },
            scores: { vectorDistance: 0.1 },
            rawVector: [1, 0],
            secret: 'synthetic-never-capture-secret',
            parentContext: {
                id: `parent-${profile.strategy}-${doc.fixtureId}`,
                ordinal: 0,
                tokenCount: 1200,
                tokenCountIsEstimate: true,
                secret: 'synthetic-parent-secret',
            },
        };
        replaceRange(row, artifact, primary.startOffset, primary.endOffset);
        replaceRange(row.parentContext, artifact, 0, artifact.text.length);
        receipts.set(row.source.receipt, { profile, docId });
        return row;
    }
    async function call(role, operation, input) {
        trace.push({ role, operation, input });
        statuses.set(role, 200);
        if (
            (role === 'foreign' ||
                (role === 'reader' && !grants.get(input.collectionId))) &&
            operation.startsWith('indexing.')
        ) {
            statuses.set(role, options.actualDeniedStatus ?? 403);
            throw Object.assign(new Error('synthetic restricted'), {
                status: 403,
                code: 'FORBIDDEN',
            });
        }
        if (operation === 'documents.list')
            return {
                total: uploaded.size,
                items: [...uploaded].map(([id]) => ({ id, status: 'READY' })),
            };
        if (operation === 'collections.list')
            return { total: collections.size, items: [] };
        if (operation === 'documents.upload') {
            const doc = fixtures.manifest.documents.find(
                (value) => value.fileName === input.file.name
            );
            assert(doc);
            assert.equal(
                sha256(new Uint8Array(await input.file.arrayBuffer())),
                doc.originalSha256
            );
            const id = 'doc-' + String(uploaded.size + 1).padStart(2, '0');
            uploaded.set(id, doc);
            return { id, versionId: 'version-' + id };
        }
        if (operation === 'documents.details')
            return {
                version: {
                    id: 'version-' + input.id,
                    version: 1,
                    status: 'READY',
                },
            };
        if (operation === 'documents.preview') {
            const doc = uploaded.get(input.id),
                text = fixtures.artifacts[doc.fixtureId].text;
            return {
                version: 1,
                text,
                totalCharacters: text.length,
                nextOffset: null,
            };
        }
        if (operation === 'collections.create') {
            const strategy = input.profile.chunkingStrategy,
                id = 'collection-' + strategy;
            collections.set(id, {
                strategy,
                configuration: structuredClone(input.profile),
                metadata: new Map(),
                generationId: 'generation-' + strategy,
            });
            return {
                id,
                configurationRevision: 1,
                configuration: structuredClone(input.profile),
            };
        }
        if (operation === 'documents.setCollection') {
            assert(collections.has(input.collectionId));
            return { success: true };
        }
        if (operation === 'indexing.updateMetadata') {
            assert.equal(input.expectedMetadataRevision, 1);
            collections
                .get(input.collectionId)
                .metadata.set(input.documentId, structuredClone(input));
            return { success: true };
        }
        if (operation === 'indexing.documents') {
            const p = collections.get(input.collectionId);
            return { total: p.metadata.size, items: [...p.metadata.values()] };
        }
        if (operation === 'indexing.probe')
            return {
                provider: 'OLLAMA',
                model: fixtures.policy.model.model,
                digest: fixtures.policy.model.digest,
                dimensions: 768,
                preset: 'EMBEDDING_GEMMA',
                identityKind: 'WEIGHTS_DIGEST',
                contextTokens: 2048,
            };
        if (operation === 'indexing.start') {
            const p = collections.get(input.collectionId);
            assert.equal(p.metadata.size, 24);
            return { generationId: p.generationId };
        }
        if (operation === 'indexing.status') {
            const p = collections.get(input.collectionId);
            return {
                configurationRevision: 1,
                unsupportedReason: null,
                active: {
                    id: p.generationId,
                    status: 'ACTIVE',
                    modelIdentity: fixtures.policy.model.digest,
                    parentContextVersion: 'parent-context-utf8-v1',
                },
            };
        }
        if (operation === 'indexing.search') {
            const p = collections.get(input.collectionId);
            let docId = input.filters.documentIds?.[0];
            if (!docId) {
                const query = fixtures.queries.find(
                    (value) => value.text === input.query
                );
                assert(query);
                const label = fixtures.qrels.find(
                    (value) => value.queryId === query.id
                );
                docId = [...uploaded].find(
                    ([, value]) =>
                        value.fixtureId === label.editions[0].fixtureId
                )[0];
            }
            if (
                options.sourceProbeNoMatch &&
                input.topK === 1 &&
                role === 'owner'
            )
                return { generationId: p.generationId, results: [] };
            if (options.foreignResult && input.topK === 10)
                return {
                    generationId: p.generationId,
                    model: fixtures.policy.model.model,
                    strategy: input.strategy,
                    results: [
                        { ...response(p, docId), documentId: 'foreign-doc' },
                    ],
                    parentUnderfilled: true,
                    vectorUnderfilled: false,
                };
            if (
                options.oneQueryFailure &&
                input.topK === 10 &&
                trace.filter(
                    (row) =>
                        row.operation === 'indexing.search' &&
                        row.input.topK === 10
                ).length === 1
            )
                throw Object.assign(
                    new Error('raw provider synthetic-never-capture-secret'),
                    { status: 503, data: { errorCode: 'PROVIDER_UNAVAILABLE' } }
                );
            const selected = response(p, docId);
            if (options.unexpectedContent)
                selected.text += ' synthetic-unexpected-sensitive-text';
            if (role === 'reader' && options.readerContradiction === 'text')
                selected.text += ' synthetic-unexpected-reader-text';
            if (role === 'reader' && options.readerContradiction === 'counter')
                selected.parentContext.tokenCount = 'synthetic-unsafe-counter';
            return {
                generationId: p.generationId,
                model:
                    role === 'reader' && options.readerContradiction === 'model'
                        ? 'synthetic-wrong-reader-model'
                        : fixtures.policy.model.model,
                strategy: input.strategy,
                results: [selected],
                parentUnderfilled: true,
                vectorUnderfilled: false,
            };
        }
        if (operation === 'indexing.sourcePreview') {
            const found = receipts.get(input.receipt);
            assert(found);
            const doc = uploaded.get(found.docId),
                artifact = fixtures.artifacts[doc.fixtureId],
                source = artifact.sources[input.sourceIndex ?? 0];
            return {
                version: 1,
                source: structuredClone(source),
                totalSources: artifact.sources.length,
                text: artifact.text.slice(source.start, source.end),
                totalCharacters: source.end - source.start,
                nextOffset: null,
            };
        }
        if (operation === 'indexing.sourceOriginal') {
            const found = receipts.get(input.receipt);
            assert(found);
            const doc = uploaded.get(found.docId);
            statuses.set(role, options.sourceOriginalStatus ?? 200);
            return new File([bytes.get(doc.fixtureId)], doc.fileName);
        }
        if (operation === 'collections.setGrant') {
            grants.set(input.id, true);
            return { success: true };
        }
        if (operation === 'collections.removeGrant') {
            grants.set(input.id, false);
            return { success: true };
        }
        throw new Error('UNEXPECTED_MOCK_OPERATION');
    }
    async function observeGeneration({
        organizationId,
        collectionId,
        generationId,
    }) {
        const p = collections.get(collectionId);
        return {
            organizationId,
            collectionId,
            generationId,
            configurationRevision: 1,
            modelIdentity: fixtures.policy.model.digest,
            parentContextVersion: 'parent-context-utf8-v1',
            chunkerVersion:
                p.strategy === 'DOCUMENT_STRUCTURE'
                    ? 'structure-utf8-v1'
                    : p.strategy === 'TOKEN_WINDOW'
                      ? 'token-window-utf8-v1'
                      : 'semantic-utf8-v1',
            model: fixtures.policy.model.model,
            dimensions: 768,
            embeddingPreset: 'EMBEDDING_GEMMA',
            contextTokens: 2048,
            endpointIsOwned: true,
            capabilitySnapshotSha256: '3'.repeat(64),
            profile: Object.fromEntries(
                Object.entries(fixtures.policy.profile).filter(
                    ([key]) => key !== 'maxEmbeddingInputBytes'
                )
            ),
            publications: [...uploaded].map(([id, doc]) => ({
                id: `pub-${p.strategy}-${doc.fixtureId}`,
                documentId: id,
                version: 1,
                sourceVersionId: 'version-' + id,
                originalSha256: doc.originalSha256,
            })),
        };
    }
    const checkpoints = [];
    const execute = (override = {}) =>
        collectQuality({
            fixtures,
            state: state(),
            bootstrap: bootstrap(),
            api: { call, observedStatus: (role) => statuses.get(role) },
            originalBytes: async (doc) => bytes.get(doc.fixtureId),
            observeGeneration,
            sleep: async () => {
                throw new Error('MOCK_UNEXPECTED_WAIT');
            },
            checkpoint: async (value) => {
                checkpoints.push({
                    runs: value.runs.length,
                    status: value.collectionEvidence.status,
                });
            },
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
            ...override,
        });
    return { trace, execute, checkpoints, response, uploaded, collections };
}

test('owned-state and explicit bootstrap refuse wrong tenant/resources/provider/DSN before protocol I/O', () => {
    validateQualityState(state(), bootstrap(), runId);
    for (const mutation of [
        (s) => {
            s.applicationDatabase = 'application';
        },
        (s) => {
            s.environment.DATABASE_URL = 'postgresql://outside/app_test';
        },
        (s) => {
            s.resources.rustfs.volume = 'user-owned-volume';
        },
        (s) => {
            s.resources.postgres.id = 'bad';
        },
        (s) => {
            s.environment.VECTORIX_DEFAULT_OPENAI_API_KEY = 'unexpected';
        },
        (s) => {
            s.environment.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS +=
                ',http://outside.test';
        },
        (s) => {
            s.apiOrigin = 'https://outside.test';
        },
        (s) => {
            s.ports.redis = s.ports.postgres;
        },
    ]) {
        const value = state();
        mutation(value);
        assert.throws(() => validateQualityState(value, bootstrap(), runId));
    }
    const bad = bootstrap();
    bad.users.reader.organizationId = 'org-b';
    assert.throws(
        () => validateBootstrap(bad, state()),
        /BOOTSTRAP_MEMBERSHIPS/u
    );
});
test('fixed 24/3 normal-API mock journey records72 separate source probes+720cells+12access checks without secrets', async () => {
    const mock = await mockProtocol({ actualDeniedStatus: 404 }),
        capture = await mock.execute();
    assert.equal(capture.documents.length, 24);
    assert.equal(capture.profiles.length, 3);
    assert.equal(capture.sourceProofs.length, 72);
    assert.equal(capture.runs.length, 720);
    assert.equal(capture.accessChecks.length, 12);
    assert(capture.sourceProofs.every((proof) => proof.httpStatus === 200));
    assert(
        capture.accessChecks
            .filter((check) => check.kind !== 'CURRENT_READER_ALLOWED')
            .every((check) => check.httpStatus === 404)
    );
    assert.equal(capture.collectionEvidence.unscoredSourceProbeAttempts, 72);
    assert.equal(capture.collectionEvidence.unscoredSourceProbeSuccesses, 72);
    const searches = mock.trace.filter(
        (row) => row.operation === 'indexing.search'
    );
    assert.equal(
        searches.filter((row) => row.role === 'owner' && row.input.topK === 1)
            .length,
        72
    );
    assert.equal(
        searches.filter((row) => row.role === 'owner' && row.input.topK === 10)
            .length,
        720
    );
    assert.equal(
        mock.trace.filter((row) => row.operation === 'indexing.sourceOriginal')
            .length,
        72
    );
    assert.equal(
        mock.trace.filter((row) => row.operation === 'indexing.updateMetadata')
            .length,
        72
    );
    for (const start of mock.trace.filter(
        (row) => row.operation === 'indexing.start'
    )) {
        assert.equal(
            mock.trace.filter(
                (row) =>
                    row.operation === 'indexing.updateMetadata' &&
                    row.input.collectionId === start.input.collectionId
            ).length,
            24
        );
    }
    assert(
        capture.sourceProofs.every(
            (proof) =>
                proof.canonicalEvidence.method ===
                'LIBRARY_CURRENT_V1_FULL_PREVIEW_PLUS_INDEXED_SEGMENTS'
        )
    );
    assert(
        capture.sourceProofs.some(
            (proof) =>
                proof.canonicalEvidence
                    .referenceGapCharactersNotReturnedByIndexedPreview > 0
        )
    );
    const encoded = JSON.stringify(capture);
    assert(!encoded.includes('synthetic-secret-receipt'));
    assert(!encoded.includes('synthetic-never-capture-secret'));
    assert(!encoded.includes('rawVector'));
    const report = evaluateCapture(fixtures, capture);
    assert.equal(report.status, 'NOT_RUN');
    assert.equal(report.qualityGatesStatus, 'PASS');
    assert.equal(report.hardViolations.length, 0);
    assert.equal(report.observedQueryCells, 720);
    assert(mock.checkpoints.at(-1).status === 'CAPTURED_NOT_YET_EVALUATED');
});
test('source proof never retries with another query to hide an empty top1 probe', async () => {
    const mock = await mockProtocol({ sourceProbeNoMatch: true });
    await assert.rejects(mock.execute(), /EXACT_SOURCE_PROBE_NO_MATCH/u);
    assert.equal(
        mock.trace.filter((row) => row.operation === 'indexing.search').length,
        1
    );
    assert.equal(
        mock.trace.filter((row) => row.operation === 'indexing.sourceOriginal')
            .length,
        0
    );
    assert.equal(mock.checkpoints.at(-1).status, 'STOPPED_INCOMPLETE');
});
test('query failure remains one of720 cells, sanitized, with no hidden alternate/retry', async () => {
    const mock = await mockProtocol({ oneQueryFailure: true }),
        capture = await mock.execute();
    assert.equal(capture.runs.length, 720);
    assert.equal(
        capture.runs.filter((row) => row.status === 'ERROR').length,
        1
    );
    assert.equal(
        capture.runs.find((row) => row.status === 'ERROR').errorCode,
        'PROVIDER_UNAVAILABLE'
    );
    assert.equal(
        mock.trace.filter(
            (row) =>
                row.operation === 'indexing.search' && row.input.topK === 10
        ).length,
        720
    );
    assert.equal(evaluateCapture(fixtures, capture).qualityGatesStatus, 'FAIL');
    assert(!JSON.stringify(capture).includes('raw provider'));
});
test('profile uses frozen scalar/range metadata and result projection rejects unrelated IDs and65source spans', async () => {
    for (const strategy of fixtures.policy.strategies) {
        const profile = profileFor(fixtures, strategy);
        assert.equal(profile.provider, 'OLLAMA');
        assert.equal(profile.dimensions, 768);
        assert.equal(profile.embeddingPreset, 'EMBEDDING_GEMMA');
        assert.equal(profile.chunking.semanticPercentile, 90);
        assert(
            isDeepStrictEqual(
                profile.metadataFields,
                fixtures.manifest.metadataFields
            )
        );
    }
    const mock = await mockProtocol();
    const capture = await mock.execute();
    const original = capture.passages[0];
    const result = {
            ...original,
            parentContext: structuredClone(original.parentContext),
        },
        document = capture.documents.find(
            (doc) => doc.documentId === original.documentId
        ),
        profile = capture.profiles[0];
    assert.throws(
        () =>
            capturePassage(
                { ...result, documentId: 'foreign-doc' },
                { document, profile, organizationId: capture.organizationId }
            ),
        /RESULT_BINDING/u
    );
    assert.throws(
        () =>
            capturePassage(
                { ...result, sourceSpans: Array(65).fill({}) },
                { document, profile, organizationId: capture.organizationId }
            ),
        /RESULT_PROVENANCE_BOUND/u
    );
    assert.equal(safeFailure(new Error('secret')), 'REQUEST_FAILED');
});

test('a contradictory result scope stops incomplete capture instead of hiding a safety failure as an ordinary query error', async () => {
    const mock = await mockProtocol({ foreignResult: true });
    await assert.rejects(mock.execute(), /UNKNOWN_RESULT_DOCUMENT/u);
    assert.equal(
        mock.trace.filter(
            (row) =>
                row.operation === 'indexing.search' && row.input.topK === 10
        ).length,
        1
    );
    assert.equal(mock.checkpoints.at(-1).status, 'STOPPED_INCOMPLETE');
});

test('transport response bounds count actual bytes, cancel redirects/overflow and retain binary headers/cookies', async () => {
    const { boundHttpResponse } = await import('./collector-runtime.mjs');
    const binary = new Uint8Array([0, 255, 194, 169, 10]);
    const headers = new Headers({
        'content-type': 'application/octet-stream',
        'content-length': '1',
        'content-encoding': 'gzip',
    });
    headers.append('set-cookie', 'synthetic=a; HttpOnly');
    headers.append('set-cookie', 'second=b; HttpOnly');
    const value = await boundHttpResponse(new Response(binary, { headers }));
    assert.deepEqual(new Uint8Array(await value.arrayBuffer()), binary);
    assert.equal(value.headers.get('content-type'), 'application/octet-stream');
    assert.equal(value.headers.get('content-encoding'), null);
    assert.equal(value.headers.getSetCookie().length, 2);
    let cancellations = 0;
    const redirect = new Response(
        new ReadableStream({
            cancel() {
                cancellations++;
            },
        }),
        { status: 307 }
    );
    await assert.rejects(
        boundHttpResponse(redirect),
        /COLLECTOR_HTTP_REDIRECT/u
    );
    assert.equal(cancellations, 1);
    assert.equal(redirect.body.locked, false);
    const huge = new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(2 * 1024 * 1024));
                controller.enqueue(new Uint8Array(1));
            },
            cancel() {
                cancellations++;
            },
        }),
        { headers: { 'content-length': '1' } }
    );
    await assert.rejects(
        boundHttpResponse(huge),
        /COLLECTOR_RESPONSE_ACTUAL_CAP/u
    );
    assert.equal(cancellations, 2);
    assert.equal(huge.body.locked, false);
    assert.equal(
        (await boundHttpResponse(new Response(null, { status: 204 }))).status,
        204
    );
});

test('unexpected returned content is refused before entering private checkpoints', async () => {
    const mock = await mockProtocol({ unexpectedContent: true });
    let last;
    await assert.rejects(
        mock.execute({
            checkpoint: async (value) => {
                last = value;
            },
        }),
        /RESULT_CANONICAL_TEXT/u
    );
    assert.equal(last.collectionEvidence.status, 'STOPPED_INCOMPLETE');
    assert.equal(
        last.collectionEvidence.stoppedReason,
        'RESULT_CANONICAL_TEXT'
    );
    assert.equal(last.passages.length, 0);
    assert(
        !JSON.stringify(last).includes('synthetic-unexpected-sensitive-text')
    );
});

test('source proof uses actual transport status and refuses an inferred200 for a206response', async () => {
    const mock = await mockProtocol({ sourceOriginalStatus: 206 });
    let last;
    await assert.rejects(
        mock.execute({
            checkpoint: async (value) => {
                last = value;
            },
        }),
        /EXACT_ORIGINAL_HTTP_STATUS/u
    );
    assert.equal(last.sourceProofs.length, 0);
    assert.equal(last.collectionEvidence.status, 'STOPPED_INCOMPLETE');
});

test('authorized reader proof rejects reader-only model, canonical-text and parent-counter contradictions before checkpointing them', async () => {
    for (const [readerContradiction, label] of [
        ['model', 'READER_CONTROL_NO_RECEIPT'],
        ['text', 'RESULT_CANONICAL_TEXT'],
        ['counter', 'PARENT_PROVENANCE_BOUND'],
    ]) {
        const mock = await mockProtocol({ readerContradiction });
        let last;
        await assert.rejects(
            mock.execute({
                checkpoint: async (value) => {
                    last = value;
                },
            }),
            new RegExp(label, 'u')
        );
        assert.equal(last.collectionEvidence.status, 'STOPPED_INCOMPLETE');
        assert.equal(last.accessChecks.length, 0);
        assert(
            !JSON.stringify(last).includes('synthetic-unexpected-reader-text')
        );
        assert(!JSON.stringify(last).includes('synthetic-unsafe-counter'));
        assert(!JSON.stringify(last).includes('synthetic-wrong-reader-model'));
    }
});

// Exact quality-only hostname policy. Restore's localhost rules are unchanged.
test('quality browser and API origins use only their exact same-host loopback bindings', () => {
    validateQualityState(state(), bootstrap(), runId);
    for (const mutate of [
        (value) => (value.apiOrigin = 'http://localhost:3101'),
        (value) => (value.webOrigin = 'http://localhost:3100'),
        (value) =>
            (value.environment.BETTER_AUTH_URL = 'http://localhost:3101'),
        (value) => (value.environment.API_URL = 'http://localhost:3101'),
        (value) =>
            (value.environment.VECTORIX_WEB_URL = 'http://localhost:3100'),
        (value) =>
            (value.environment.TRUSTED_ORIGINS = 'http://localhost:3100'),
        (value) =>
            (value.environment.TRUSTED_ORIGINS += ',https://elsewhere.example'),
    ]) {
        const value = state();
        mutate(value);
        assert.throws(() => validateQualityState(value, bootstrap(), runId));
    }
});
