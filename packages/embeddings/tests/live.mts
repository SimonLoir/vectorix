import assert from 'node:assert/strict';
import {
    discoverModels,
    verifyEmbeddingModel,
    embedDocuments,
    embedQuery,
    type OllamaConfiguration,
} from '../src/index';

// Explicit loopback argument only: this script never loads application configuration or databases.
const endpoint = process.argv[2];
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))
    throw new Error('Pass an explicit disposable loopback Ollama endpoint.');
const config: OllamaConfiguration = {
    provider: 'OLLAMA',
    endpoint,
    apiKey: null,
};
assert(
    (await discoverModels(config)).some(
        (entry) => entry.model === 'embeddinggemma:latest'
    )
);
const samples = [
    {
        title: 'Jardin',
        text: 'Les abeilles pollinisent les fleurs et produisent du miel dans une ruche.',
    },
    {
        title: 'Cloud storage',
        text: 'An object storage bucket stores private files with their version identifiers.',
    },
    {
        title: 'Sport',
        text: 'The football team scored a goal during the championship final.',
    },
];
const cosine = (left: number[], right: number[]) =>
    left.reduce((sum, value, index) => sum + value * right[index]!, 0) /
    Math.sqrt(
        left.reduce((sum, value) => sum + value * value, 0) *
            right.reduce((sum, value) => sum + value * value, 0)
    );
for (const dimensions of [128, 256, 512, 768]) {
    const identity = await verifyEmbeddingModel(config, {
        model: 'embeddinggemma',
        dimensions,
        preset: 'EMBEDDING_GEMMA',
    });
    const documents = await embedDocuments(config, identity, samples);
    const query = await embedQuery(
        config,
        identity,
        'Quels insectes fabriquent du miel ?'
    );
    assert.equal(documents.vectors.length, samples.length);
    assert(documents.vectors.every((vector) => vector.length === dimensions));
    assert.equal(query.vectors[0]?.length, dimensions);
    const scores = documents.vectors.map((vector) =>
        cosine(query.vectors[0]!, vector)
    );
    assert(scores[0]! > scores[1]! && scores[0]! > scores[2]!);
    assert(
        documents.usage.providerInputTokens !== null &&
            documents.usage.providerInputTokens > 0
    );
    console.log(
        JSON.stringify({
            dimensions,
            digest: identity.digest,
            family: identity.family,
            architecture: identity.architecture,
            contextTokens: identity.contextTokens,
            topDocument: samples[scores.indexOf(Math.max(...scores))]!.title,
            providerInputTokens: documents.usage.providerInputTokens,
            queryProviderInputTokens: query.usage.providerInputTokens,
        })
    );
}
