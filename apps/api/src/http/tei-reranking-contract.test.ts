import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provider } from '@repo/api-contracts/v1/rag/common';
import { credentialData } from '@repo/api-contracts/v1/rag/credentials';
import {
    rerankProvider,
    rerankingContract,
    rerankProfileView,
} from '@repo/api-contracts/v1/rag/reranking';
import {
    configureExtendedRerankInput,
    extendedRerankProfile,
    extendedRerankSearchOutput,
    rerankEngineId,
    rerankRuntimeSnapshot,
    rerankEndpointView,
    rerankEndpointsContract,
} from '@repo/api-contracts/v1/rag/reranking-extended';

const runtime = {
    protocolVersion: 'native-tei-v1',
    modelId: 'BAAI/bge-reranker-v2-m3',
    modelRevision: 'a'.repeat(40),
    modelType: 'reranker',
    maxInputLength: 8192,
    maxClientBatchSize: 32,
    runtimeVersion: '1.9.4',
    modelDtype: 'float32',
};
const configuration = {
    provider: 'TEI',
    model: runtime.modelId,
    candidatePool: 32,
    bindingSource: 'ORGANIZATION',
    createdAt: new Date(0),
    runtimeSnapshot: runtime,
};

void test('revision22 provider and credential DTOs remain closed to TEI', () => {
    assert.deepEqual(rerankProvider.options, ['COHERE', 'VOYAGE']);
    assert.deepEqual(provider.options, [
        'S3',
        'OLLAMA',
        'COHERE',
        'VOYAGE',
        'OPENAI',
        'MISTRAL',
    ]);
    assert.equal(
        credentialData.safeParse({
            provider: 'TEI',
            endpoint: 'http://tei.test',
            apiKey: null,
        }).success,
        false
    );
    const input = rerankingContract.configure['~orpc'].inputSchema;
    assert(input);
    assert.equal(
        input.safeParse({
            collectionId: 'collection',
            expectedRevision: 0,
            enabled: true,
            provider: 'TEI',
            model: runtime.modelId,
            candidatePool: 32,
        }).success,
        false
    );
    assert.equal(
        rerankProfileView.safeParse({
            revision: 1,
            enabled: true,
            configuration,
            canManage: true,
            canUse: true,
        }).success,
        false
    );
});

void test('extended actual contracts accept bounded future engines without opening legacy or nested DTOs', () => {
    const input = configureExtendedRerankInput.parse({
        collectionId: 'collection',
        expectedRevision: 0,
        enabled: true,
        provider: 'FUTURE_ENGINE_2',
        model: 'operator/model',
        candidatePool: 32,
    });
    assert.equal(input.provider, 'FUTURE_ENGINE_2');
    assert.equal(
        extendedRerankProfile.parse({
            revision: 1,
            enabled: true,
            configuration,
            canManage: true,
            canUse: true,
        }).configuration?.provider,
        'TEI'
    );
    for (const value of ['', 'tei', '_TEI', 'T'.repeat(65), 'TEI with spaces'])
        assert.equal(rerankEngineId.safeParse(value).success, false);
    assert.equal(rerankEngineId.parse('T'.repeat(64)).length, 64);
    assert.equal(
        configureExtendedRerankInput.safeParse({ ...input, unknown: true })
            .success,
        false
    );
    assert.equal(
        extendedRerankProfile.safeParse({
            revision: 1,
            enabled: true,
            configuration: { ...configuration, extra: true },
            canManage: true,
            canUse: true,
        }).success,
        false
    );
});

void test('saved runtime DTO requires all fixed bounded fields and distinguishes unknown revision', () => {
    assert.deepEqual(rerankRuntimeSnapshot.parse(runtime), runtime);
    assert.equal(
        rerankRuntimeSnapshot.parse({ ...runtime, modelRevision: null })
            .modelRevision,
        null
    );
    for (const key of Object.keys(runtime)) {
        const missing: Record<string, unknown> = { ...runtime };
        delete missing[key];
        assert.equal(rerankRuntimeSnapshot.safeParse(missing).success, false);
    }
    for (const change of [
        { extra: true },
        { modelRevision: '' },
        { maxInputLength: 0 },
        { maxInputLength: 1.5 },
        { maxInputLength: '8192' },
        { maxClientBatchSize: 0 },
        { runtimeVersion: 'x'.repeat(65) },
        { modelId: 'x'.repeat(201) },
    ]) {
        assert.equal(
            rerankRuntimeSnapshot.safeParse({ ...runtime, ...change }).success,
            false
        );
    }
});

void test('extended score-kind strings are bounded and source/ordinary nested scores retain their original schema', () => {
    const legacy = rerankingContract.search['~orpc'].outputSchema;
    assert(legacy);
    assert.equal(
        extendedRerankSearchOutput.shape.results.element.shape.scores,
        legacy.shape.results.element.shape.scores
    );
    const summary = {
        revision: 1,
        provider: 'FUTURE_ENGINE',
        model: 'operator/model',
        scoreKind: 'future_normalized_score',
        candidateLimit: 32,
        candidateCount: 2,
        rerankedCount: 2,
        durationMs: 1,
        underfilled: false,
        usage: {
            providerInputTokens: null,
            billedInputTokens: null,
            billedSearchUnits: null,
        },
        attemptId: 'attempt',
    };
    assert.equal(
        extendedRerankSearchOutput.shape.reranking.parse(summary).scoreKind,
        'future_normalized_score'
    );
    for (const scoreKind of ['', 'Raw Logits', 'x'.repeat(65)])
        assert.equal(
            extendedRerankSearchOutput.shape.reranking.safeParse({
                ...summary,
                scoreKind,
            }).success,
            false
        );
    assert.equal(
        extendedRerankSearchOutput.shape.reranking.safeParse({
            ...summary,
            extra: true,
        }).success,
        false
    );
    assert.equal(
        extendedRerankSearchOutput.shape.results.element.shape.rerankScore.safeParse(
            Infinity
        ).success,
        false
    );
    assert.equal(
        extendedRerankSearchOutput.shape.results.element.shape.rerankScore.safeParse(
            NaN
        ).success,
        false
    );
});

void test('endpoint views cannot expose plaintext or ciphertext; updates distinguish preserve and explicit key clearing', () => {
    const endpoint = {
        id: 'endpoint',
        name: 'Native TEI',
        provider: 'TEI',
        revision: 1,
        endpoint: 'http://tei.test',
        apiKey: null,
        active: true,
        createdAt: new Date(0),
        updatedAt: new Date(0),
    };
    assert.equal(rerankEndpointView.parse(endpoint).apiKey, null);
    assert.equal(
        rerankEndpointView.parse({ ...endpoint, apiKey: '********' }).apiKey,
        '********'
    );
    for (const apiKey of ['plaintext', 'ciphertext-value'])
        assert.equal(
            rerankEndpointView.safeParse({ ...endpoint, apiKey }).success,
            false
        );
    const update = rerankEndpointsContract.update['~orpc'].inputSchema;
    assert(update);
    const input = {
        id: 'endpoint',
        expectedRevision: 1,
        name: 'Native TEI',
        endpoint: 'http://tei.test',
    };
    assert.equal(update.parse(input).apiKey, undefined);
    assert.equal(update.parse({ ...input, apiKey: null }).apiKey, null);
    assert.equal(
        update.parse({ ...input, apiKey: 'new-native-key' }).apiKey,
        'new-native-key'
    );
    const create = rerankEndpointsContract.create['~orpc'].inputSchema;
    assert(create);
    for (const apiKey of [
        '',
        '   ',
        '********',
        'key\nvalue',
        'key\u007Fvalue',
        'x'.repeat(8193),
    ]) {
        assert.equal(update.safeParse({ ...input, apiKey }).success, false);
        assert.equal(
            create.safeParse({
                name: input.name,
                provider: 'TEI',
                endpoint: input.endpoint,
                apiKey,
            }).success,
            false
        );
    }
    for (const endpoint of [
        'http://user@tei.test',
        'http://tei.test/path',
        'http://tei.test?query=1',
        'http://tei.test#fragment',
    ])
        assert.equal(update.safeParse({ ...input, endpoint }).success, false);
});
