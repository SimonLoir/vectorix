/** In-memory synthetic API only; frozen local artificial originals, never runtime data. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocument, documentSpec } from './load-corpus.mjs';
import * as lightGenerator from './load-light-corpus.mjs';
import { getLoadPolicy, policySha256 } from './load-policy-registry.mjs';
import {
    sha,
    LOAD_IDENTITY,
    loadResourcePolicyHash,
} from './load-import-core.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
export function importMock(options = {}) {
    const policy = getLoadPolicy(options.experimentPolicyId ?? 'DEFAULT_V1'),
        generator =
            policy.id === 'LIGHT_V1'
                ? lightGenerator
                : { buildDocument, documentSpec },
        run = 'abcdef012345',
        fixture = {
            schemaVersion: 1,
            namespace: policy.namespace,
            experimentPolicyId: policy.id,
            experimentPolicySha256: policySha256(policy),
            runId: run,
            organizationIds: ['org-a', 'org-b'],
            users: Object.fromEntries(
                ['owner', 'reader', 'foreign'].map((role) => [
                    role,
                    {
                        userId: 'user-' + role,
                        memberId: 'member-' + role,
                        organizationId: role === 'foreign' ? 'org-b' : 'org-a',
                        email: `${policy.emailPrefix}-${role}-${run}@example.test`,
                        password:
                            'SYNTHETIC_PRIVATE_PASSWORD_0123456789-' + role,
                    },
                ])
            ),
        };
    const state = {
        commit: 'a'.repeat(40),
        images: { postgres: 'sha256:' + 'b'.repeat(64) },
        resourceLimits: { ollama: { cpus: '4', memoryBytes: 6 * 1024 ** 3 } },
        loadPolicy: structuredClone(policy.loadPolicy),
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        namespace: fixture.namespace,
        runId: run,
        prefix: fixture.namespace + '-' + run,
        ports: { api: 45001, web: 45002 },
        apiOrigin: 'http://127.0.0.1:45001',
        webOrigin: 'http://127.0.0.1:45002',
        environment: {
            BETTER_AUTH_URL: 'http://127.0.0.1:45001',
            API_URL: 'http://127.0.0.1:45001',
            VECTORIX_WEB_URL: 'http://127.0.0.1:45002',
            TRUSTED_ORIGINS: 'http://127.0.0.1:45002',
        },
    };
    const manifest = JSON.parse(
            fs.readFileSync(
                path.join(here, policy.corpusRoot + '/full-preflight.json')
            )
        ),
        ref = JSON.parse(
            fs.readFileSync(
                path.join(here, '../quality/reference-v1/manifest.json')
            )
        ),
        references = { manifest: ref, artifacts: {} };
    for (const doc of ref.documents)
        references.artifacts[doc.fixtureId] = JSON.parse(
            fs.readFileSync(
                path.join(here, '../quality/reference-v1', doc.canonicalPath)
            )
        );
    const documents = new Map(),
        collections = new Map(),
        calls = [],
        journals = [],
        names = new Map([
            ...manifest.documents.map((doc) => [doc.filename, doc]),
            ...ref.documents.map((doc) => [doc.fileName, doc]),
        ]);
    let time = 0,
        idNo = 0;
    const api = {
        async call(role, operation, input) {
            time++;
            calls.push({
                role,
                operation,
                input:
                    operation === 'documents.upload'
                        ? {
                              requestId: input.requestId,
                              fileName: input.file.name,
                          }
                        : structuredClone(input),
            });
            await options.beforeCall?.({
                role,
                operation,
                input,
                documents,
                collections,
            });
            let value;
            const docRow = (doc) => ({
                    id: doc.id,
                    name: doc.file.name,
                    status: 'READY',
                }),
                own = [...documents.values()].filter(
                    (doc) => doc.role === role
                );
            if (operation === 'documents.list')
                value = {
                    items: own
                        .slice(input.offset, input.offset + input.limit)
                        .map(docRow),
                    total: own.length,
                };
            else if (operation === 'collections.list') {
                const rows = [...collections.values()].filter(
                    (col) => col.role === role
                );
                value = {
                    items: rows.map((col) => ({ id: col.id })),
                    total: rows.length,
                };
            } else if (operation === 'documents.upload') {
                const id = 'doc-' + ++idNo,
                    descriptor = names.get(input.file.name);
                documents.set(id, {
                    id,
                    versionId: 'version-' + id,
                    role,
                    file: input.file,
                    descriptor,
                    text: descriptor.fixtureId
                        ? references.artifacts[descriptor.fixtureId].text
                        : await input.file.text(),
                });
                value = { id, versionId: 'version-' + id };
            } else if (operation === 'documents.details') {
                const doc = documents.get(input.id);
                value = {
                    document: docRow(doc),
                    canManage: true,
                    version: {
                        id: doc.versionId,
                        version: 1,
                        status: 'READY',
                        byteSize: doc.file.size,
                        mediaType: doc.file.type,
                        stored: true,
                    },
                };
            } else if (operation === 'documents.preview') {
                const doc = documents.get(input.id),
                    text = doc.text.slice(input.offset, input.offset + 20000),
                    next = input.offset + text.length;
                value = {
                    text,
                    nextOffset: next === doc.text.length ? null : next,
                    totalCharacters: doc.text.length,
                    version: 1,
                };
            } else if (operation === 'documents.download')
                value = documents.get(input.id).file;
            else if (operation === 'collections.create') {
                const id = 'collection-' + ++idNo,
                    col = {
                        id,
                        role,
                        name: input.name,
                        profile: structuredClone(input.profile),
                        documents: new Map(),
                        generationId: null,
                        polls: 0,
                    };
                collections.set(id, col);
                value = {
                    id,
                    name: col.name,
                    configurationRevision: 1,
                    configuration: col.profile,
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                };
            } else if (operation === 'collections.get') {
                const col = collections.get(input.id);
                value = {
                    id: col.id,
                    configurationRevision: 1,
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                    configuration: structuredClone(col.profile),
                };
            } else if (operation === 'documents.setCollection') {
                collections
                    .get(input.collectionId)
                    .documents.set(input.id, { documentId: input.id });
                value = { success: true };
            } else if (operation === 'indexing.updateMetadata') {
                Object.assign(
                    collections
                        .get(input.collectionId)
                        .documents.get(input.documentId),
                    {
                        language: input.language,
                        tags: structuredClone(input.tags),
                        metadata: structuredClone(input.metadata),
                    }
                );
                value = { success: true };
            } else if (operation === 'indexing.documents') {
                const rows = [
                    ...collections.get(input.collectionId).documents.values(),
                ].map((row) => ({
                    ...row,
                    libraryVersion: 1,
                    metadataRevision: 2,
                }));
                value = {
                    items: rows.slice(input.offset, input.offset + input.limit),
                    total: rows.length,
                };
            } else if (operation === 'indexing.tasks')
                value = { items: [], total: 0 };
            else if (operation === 'indexing.probe')
                value = {
                    provider: 'OLLAMA',
                    model: 'embeddinggemma:latest',
                    digest: LOAD_IDENTITY.weights,
                    dimensions: 768,
                    preset: 'EMBEDDING_GEMMA',
                    identityKind: 'WEIGHTS_DIGEST',
                    contextTokens: 2048,
                };
            else if (operation === 'indexing.start') {
                const col = collections.get(input.collectionId);
                col.generationId = 'generation-' + ++idNo;
                value = { generationId: col.generationId };
            } else if (operation === 'indexing.status') {
                const col = collections.get(input.collectionId),
                    ready = ++col.polls > 1,
                    count = [...col.documents.values()].reduce(
                        (n, row) =>
                            n +
                            (documents.get(row.documentId).descriptor
                                .actualChildren ?? 1),
                        0
                    ),
                    generation = {
                        id: col.generationId,
                        status: ready ? 'ACTIVE' : 'BUILDING',
                        modelIdentity: LOAD_IDENTITY.weights,
                        dimensions: 768,
                        projectedChunks: count,
                        totalDocuments: col.documents.size,
                        publishedDocuments: col.documents.size,
                    };
                value = {
                    configurationRevision: 1,
                    deletedAt: null,
                    unsupportedReason: null,
                    canRead: true,
                    canManage: true,
                    active: ready ? generation : null,
                    generations: [generation],
                    usage: {
                        activeChunks: ready ? count : 0,
                        retainedChunks: 0,
                        reservedChunks: 0,
                        activeLimit: 100000,
                        temporaryLimit: 100000,
                    },
                };
            } else throw new Error('MOCK_UNEXPECTED_OPERATION');
            if (options.response)
                value = options.response({
                    role,
                    operation,
                    input,
                    value,
                    documents,
                    collections,
                });
            return {
                value,
                http: {
                    status: 200,
                    responseBytes:
                        value instanceof File
                            ? value.size
                            : Buffer.byteLength(JSON.stringify(value)),
                    startedMicros: time * 1000,
                    bodyReadMicros: time * 1000,
                    endedMicros: time * 1000,
                },
            };
        },
    };
    const readOriginal = async (descriptor) =>
        descriptor.fileName.startsWith(policy.version + '-')
            ? Buffer.from(
                  generator.buildDocument(
                      generator.documentSpec(
                          Number(descriptor.fixtureId.slice(-4))
                      )
                  )
              )
            : new Uint8Array(
                  fs.readFileSync(
                      path.join(
                          here,
                          '../quality/reference-v1',
                          descriptor.originalPath
                      )
                  )
              );
    const nativeBaselines = new Map();
    const beginIndexObservation = async (input) => {
        assert.equal(collections.get(input.collectionId).generationId, null);
        const baseline = {
            schemaVersion: 1,
            kind: 'INDEPENDENT_NATIVE_BASELINE',
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
            runId: run,
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            collectionRole: input.collectionRole,
            policySha256: input.policySha256,
            workload: 'INDEXING',
            provider: 'OLLAMA',
            stable: true,
            exclusive: true,
            baselineSha256: sha(
                'synthetic-native-baseline-' + input.collectionId
            ),
            producerIdentitySha256: sha('synthetic-owned-worker'),
        };
        nativeBaselines.set(input.collectionId, structuredClone(baseline));
        return options.nativeBaseline
            ? options.nativeBaseline(baseline, input)
            : baseline;
    };
    const observeGeneration = async (input) => {
        assert.deepEqual(
            input.nativeBaseline,
            nativeBaselines.get(input.collectionId)
        );
        time++;
        const publications = input.bindings.map((binding, index) => {
                const doc = input.descriptors[index];
                return {
                    documentId: binding.documentId,
                    versionId: binding.versionId,
                    version: 1,
                    originalSha256: doc.originalSha256,
                    canonicalSha256: doc.canonicalSha256,
                    childCount: doc.expectedGeometrySha256 ? 500 : 1,
                    parentCount: doc.expectedGeometrySha256 ? 125 : 1,
                    geometrySha256:
                        doc.expectedGeometrySha256 ?? 'a'.repeat(64),
                    preparedInputHashesSha256: 'b'.repeat(64),
                };
            }),
            children = publications.reduce((n, p) => n + p.childCount, 0),
            parents = publications.reduce((n, p) => n + p.parentCount, 0);
        const proof = {
            schemaVersion: 1,
            kind: 'INDEPENDENT_READ_ONLY',
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
            runId: run,
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            collectionRole: input.collectionRole,
            policySha256: input.policySha256,
            generationId: input.generationId,
            configurationRevision: 1,
            status: 'ACTIVE',
            modelIdentity: LOAD_IDENTITY.weights,
            dimensions: 768,
            chunkerVersion: 'token-window-utf8-v1',
            parentContextVersion: 'parent-context-utf8-v1',
            profileMatches: true,
            endpointIsOwned: true,
            quiescent: true,
            allCanonicalGeometryVerified: true,
            allPreparedInputHashesVerified: true,
            allPhysicalManifestRowsVerified: true,
            activeSourceVersionTuplesVerified: true,
            publications,
            physicalChildren: children,
            parents,
            usage: {
                validatedNativeVectors: children,
                retries: 0,
                errors: 0,
                providerInputTokens: null,
                nativeWorkProof: {
                    collectionRole: input.collectionRole,
                    policySha256: input.policySha256,
                    kind: 'EXCLUSIVE_INDEXING_DELTA',
                    baselineSha256: input.nativeBaseline.baselineSha256,
                    producerIdentitySha256:
                        input.nativeBaseline.producerIdentitySha256,
                    finalSha256: sha(
                        'synthetic-native-final-' + input.collectionId
                    ),
                    receiptSha256: sha(
                        'synthetic-native-receipt-' + input.collectionId
                    ),
                    stableFinal: true,
                    exclusive: true,
                    knownGapReports: '0',
                    nativeBatches: publications.reduce(
                        (total, pub) => total + Math.ceil(pub.childCount / 64),
                        0
                    ),
                    nativeStartedBatches: publications.reduce(
                        (total, pub) => total + Math.ceil(pub.childCount / 64),
                        0
                    ),
                    nativeFinishedBatches: publications.reduce(
                        (total, pub) => total + Math.ceil(pub.childCount / 64),
                        0
                    ),
                    nativeBatchErrors: 0,
                },
            },
            manifestSha256: sha(JSON.stringify(publications)),
        };
        return options.observation ? options.observation(proof, input) : proof;
    };
    const beginMeasurements = async () => {
        const began = time;
        return {
            finish: async () => ({
                schemaVersion: 1,
                kind: 'INDEPENDENT_RESOURCE_SAMPLES',
                evidenceKind: 'SYNTHETIC_UNIT_TEST',
                runId: run,
                samples: 2,
                durationMs: time - began,
                minimumFreeBytes: 5 * 1024 ** 3,
                peakMemoryBytes: 1024 ** 3,
                resourcePolicySha256: loadResourcePolicyHash(state),
                modelWarmState: 'UNKNOWN',
                oom: false,
                processLost: false,
                safetyReserveBreached: false,
            }),
        };
    };
    const checkpoint = async (value) => {
        const encoded = JSON.stringify(value);
        if (
            encoded.includes('SYNTHETIC_PRIVATE_PASSWORD') ||
            encoded.includes('stable context') ||
            encoded.includes('Café')
        )
            throw new Error('CONTENT_IN_JOURNAL');
        journals.push(structuredClone(value));
        await options.checkpoint?.(value);
    };
    return {
        state,
        fixture,
        manifest,
        references,
        api,
        readOriginal,
        observeGeneration,
        beginIndexObservation,
        beginMeasurements,
        nativeBaselines,
        checkpoint,
        now: () => time,
        sleep: async (ms) => {
            time += ms;
        },
        evidenceKind: 'SYNTHETIC_UNIT_TEST',
        documents,
        collections,
        calls,
        journals,
    };
}
