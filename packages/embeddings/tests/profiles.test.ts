import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
    getRecommendedEmbeddingDefaults,
    getReviewedEmbeddingProfile,
    listReviewedEmbeddingProfiles,
    supportsReviewedEmbeddingDimensions,
} from '../src/profiles';
import { verifyEmbeddingModel } from '../src/index';
import snapshots from './reviewed-default-snapshots.json' with { type: 'json' };

await test('browser profile entry has only its dependency-free reviewed catalog in its module closure', async () => {
    const source = await readFile(
        new URL('../src/profiles.ts', import.meta.url),
        'utf8'
    );
    const catalog = await readFile(
        new URL('../src/reviewed-models.ts', import.meta.url),
        'utf8'
    );
    assert.deepEqual(
        [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map(
            (match) => match[1]
        ),
        ['./reviewed-models']
    );
    for (const content of [source, catalog])
        assert.doesNotMatch(
            content,
            /\b(?:require\s*\(|import\s*\(|process\s*\.|Buffer\b|fetch\s*\()/
        );
    assert.doesNotMatch(catalog, /\b(?:import|export)\s.*\bfrom\s/);
});

await test('reviewed provider choices use exact models and natural defaults with safe creation settings', () => {
    const expected = {
        COHERE: [
            ['embed-v4.0', 1536],
            ['embed-english-v3.0', 1024],
            ['embed-multilingual-v3.0', 1024],
        ],
        VOYAGE: [
            ['voyage-4', 1024],
            ['voyage-4-lite', 1024],
            ['voyage-4-large', 1024],
        ],
        OPENAI: [
            ['text-embedding-3-small', 1536],
            ['text-embedding-3-large', 3072],
        ],
        MISTRAL: [
            ['mistral-embed', 1024],
            ['mistral-embed-2312', 1024],
        ],
    };
    for (const [provider, models] of Object.entries(expected)) {
        assert.deepEqual(
            listReviewedEmbeddingProfiles(provider).map((profile) => [
                profile.model,
                profile.defaultDimensions,
            ]),
            models
        );
        for (const profile of listReviewedEmbeddingProfiles(provider)) {
            assert.deepEqual(
                getReviewedEmbeddingProfile(provider, profile.model),
                profile
            );
            assert.deepEqual(
                getRecommendedEmbeddingDefaults(provider, profile.model),
                {
                    dimensions: profile.defaultDimensions,
                    embeddingPreset: 'GENERIC',
                    preparation: '',
                    metric: 'cosine',
                    numericType: 'float32',
                    indexType: 'DISKANN',
                }
            );
            assert(
                supportsReviewedEmbeddingDimensions(
                    profile,
                    profile.defaultDimensions
                )
            );
            assert.equal(
                getReviewedEmbeddingProfile(
                    provider,
                    `${profile.model}:latest`
                ),
                undefined
            );
            assert.equal(
                getReviewedEmbeddingProfile(
                    provider,
                    profile.model.toUpperCase()
                ),
                undefined
            );
            assert.equal(
                getRecommendedEmbeddingDefaults(provider, 'unreviewed-model'),
                undefined
            );
        }
    }
    assert.deepEqual(listReviewedEmbeddingProfiles('UNKNOWN'), []);
    assert.equal(
        getRecommendedEmbeddingDefaults('UNKNOWN', 'embeddinggemma'),
        undefined
    );
});

for (const provider of ['COHERE', 'VOYAGE', 'OPENAI', 'MISTRAL'])
    await test(`${provider} dimension validation preserves supported reductions and rejects invalid sizes`, () => {
        for (const profile of listReviewedEmbeddingProfiles(provider)) {
            for (const invalid of [NaN, Infinity, -1, 0, 1.5])
                assert.equal(
                    supportsReviewedEmbeddingDimensions(profile, invalid),
                    false
                );
            if (profile.dimensionCapability) {
                const range = profile.dimensionCapability;
                for (const dimensions of [range.minimum, 257, range.maximum])
                    assert(
                        supportsReviewedEmbeddingDimensions(profile, dimensions)
                    );
                assert.equal(
                    supportsReviewedEmbeddingDimensions(
                        profile,
                        range.maximum + 1
                    ),
                    false
                );
            } else {
                for (const dimensions of profile.dimensions)
                    assert(
                        supportsReviewedEmbeddingDimensions(profile, dimensions)
                    );
                assert.equal(
                    supportsReviewedEmbeddingDimensions(profile, 257),
                    false
                );
            }
        }
    });

await test('high-dimensional reviewed defaults keep a compatible index', () => {
    const large = getReviewedEmbeddingProfile(
        'OPENAI',
        'text-embedding-3-large'
    )!;
    assert.equal(large.defaultDimensions, 3072);
    assert.equal(
        getRecommendedEmbeddingDefaults('OPENAI', large.model)?.indexType,
        'DISKANN'
    );
    const voyage = getReviewedEmbeddingProfile('VOYAGE', 'voyage-4')!;
    assert(supportsReviewedEmbeddingDimensions(voyage, 2048));
    assert.equal(
        getRecommendedEmbeddingDefaults('VOYAGE', voyage.model)?.indexType,
        'DISKANN'
    );
});

await test('Ollama recommendation never supplies an inferred capability or claims installed model discovery', () => {
    assert.deepEqual(listReviewedEmbeddingProfiles('OLLAMA'), []);
    for (const model of ['embeddinggemma', 'embeddinggemma:latest']) {
        assert.equal(getReviewedEmbeddingProfile('OLLAMA', model), undefined);
        assert.deepEqual(getRecommendedEmbeddingDefaults('OLLAMA', model), {
            dimensions: 768,
            embeddingPreset: 'EMBEDDING_GEMMA',
            preparation: '',
            metric: 'cosine',
            numericType: 'float32',
            indexType: 'DISKANN',
        });
    }
    for (const model of [
        'unreviewed',
        'some-embedding-model',
        'EmbeddingGemma',
        'embeddinggemma:custom',
        'namespace/embeddinggemma:latest',
        'embeddinggemma:latest ',
    ]) {
        assert.equal(getReviewedEmbeddingProfile('OLLAMA', model), undefined);
        assert.equal(
            getRecommendedEmbeddingDefaults('OLLAMA', model),
            undefined
        );
    }
});

/** Native probes use synthetic vectors on loopback; no provider account or application state is involved. */
async function withNativeFixture(run: (endpoint: string) => Promise<void>) {
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
            model: string;
            texts?: string[];
            input?: string[];
            output_dimension?: number;
            dimensions?: number;
        };
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/v1/models')) {
            response.end(
                JSON.stringify({
                    models: listReviewedEmbeddingProfiles('COHERE').map(
                        ({ model }) => ({ name: model, endpoints: ['embed'] })
                    ),
                })
            );
            return;
        }
        if (!['/v2/embed', '/v1/embeddings'].includes(request.url ?? '')) {
            response.writeHead(404);
            response.end();
            return;
        }
        const dimensions =
            body.output_dimension ??
            body.dimensions ??
            (body.model === 'embed-v4.0' ? 1536 : 1024);
        const inputs = body.texts ?? body.input!;
        const vector = Array.from({ length: dimensions }, (_, index) =>
            index === 0 ? 1 : 0
        );
        response.end(
            JSON.stringify(
                body.texts
                    ? {
                          embeddings: { float: inputs.map(() => vector) },
                          texts: body.texts,
                      }
                    : {
                          object: 'list',
                          model: body.model,
                          data: inputs.map((_, index) => ({
                              object: 'embedding',
                              index,
                              embedding: vector,
                          })),
                      }
            )
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

await test('all reviewed defaults match native capabilities and retain pre-extraction saved identity bytes', () =>
    withNativeFixture(async (endpoint) => {
        let verified = 0;
        for (const provider of ['COHERE', 'VOYAGE', 'OPENAI', 'MISTRAL'])
            for (const profile of listReviewedEmbeddingProfiles(provider)) {
                const identity = await verifyEmbeddingModel(
                    {
                        provider: profile.provider,
                        endpoint:
                            provider === 'OPENAI' || provider === 'MISTRAL'
                                ? `${endpoint}/v1`
                                : endpoint,
                        apiKey: 'synthetic-default-profile-fixture',
                    },
                    {
                        model: profile.model,
                        dimensions: profile.defaultDimensions,
                        preset: 'GENERIC',
                    }
                );
                assert.equal(identity.contextTokens, profile.contextTokens);
                assert.equal(
                    identity.defaultDimensions,
                    profile.defaultDimensions
                );
                assert.equal(identity.dimensions, profile.defaultDimensions);
                if (profile.dimensionCapability) {
                    assert('dimensionCapability' in identity);
                    assert.deepEqual(
                        identity.dimensionCapability,
                        profile.dimensionCapability
                    );
                } else {
                    assert.deepEqual(
                        identity.supportedDimensions,
                        profile.dimensions
                    );
                }
                const key =
                    `${provider}:${profile.model}` as keyof typeof snapshots;
                const expected = snapshots[key];
                assert(expected);
                assert.equal(identity.digest, expected.digest);
                assert.equal(
                    createHash('sha256')
                        .update(JSON.stringify(identity))
                        .digest('hex'),
                    expected.snapshotSha256
                );
                verified++;
            }
        assert.equal(verified, Object.keys(snapshots).length);
        assert.equal(verified, 10);
    }));
