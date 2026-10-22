import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createCohereHttpFixture,
    COHERE_ORGANIZATION_KEY,
} from './cohere-fixtures';
import {
    createVoyageHttpFixture,
    VOYAGE_ORGANIZATION_KEY,
} from './voyage-fixtures';
import {
    createOpenAIHttpFixture,
    OPENAI_ORGANIZATION_KEY,
} from './openai-fixtures';
import {
    createMistralHttpFixture,
    MISTRAL_ORGANIZATION_KEY,
} from './mistral-fixtures';
import {
    assertParentPublication,
    createParentFixture,
    parentSizes,
    parentText,
    scanParent,
} from './parent-fixtures';

/** Five real native HTTP protocols with synthetic vectors; no paid connectivity or relevance claim. */
export async function parentProviderTests(t: TestContext) {
    const fixture = await createParentFixture('Native strategy matrix');
    const providersToClose: { close(): Promise<void> }[] = [];
    try {
        const cohere = await createCohereHttpFixture();
        providersToClose.push(cohere);
        const voyage = await createVoyageHttpFixture();
        providersToClose.push(voyage);
        const openai = await createOpenAIHttpFixture();
        providersToClose.push(openai);
        const mistral = await createMistralHttpFixture();
        providersToClose.push(mistral);
        process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = [
            fixture.endpoint,
            cohere.endpoint,
            voyage.endpoint,
            openai.endpoint,
            mistral.endpoint,
        ].join(',');
        const ollamaInputs: string[] = [];
        fixture.state.vectorForText = (text) => {
            ollamaInputs.push(text);
            return [1 + (text.match(/renard|fox/gi)?.length ?? 0), 1, 1];
        };
        const providers = [
            {
                provider: 'OLLAMA',
                model: 'fixture:latest',
                dimensions: 3,
                endpoint: fixture.endpoint,
                apiKey: null,
                inputs: () => ollamaInputs,
            },
            {
                provider: 'COHERE',
                model: 'embed-v4.0',
                dimensions: 256,
                endpoint: cohere.endpoint,
                apiKey: COHERE_ORGANIZATION_KEY,
                inputs: () =>
                    cohere
                        .embeddings()
                        .flatMap((call) => call.body.texts ?? []),
            },
            {
                provider: 'VOYAGE',
                model: 'voyage-4',
                dimensions: 256,
                endpoint: voyage.endpoint,
                apiKey: VOYAGE_ORGANIZATION_KEY,
                inputs: () =>
                    voyage.state.calls
                        .filter((call) => call.path === '/v1/embeddings')
                        .flatMap((call) => call.body.input ?? []),
            },
            {
                provider: 'OPENAI',
                model: 'text-embedding-3-small',
                dimensions: 257,
                endpoint: openai.endpoint,
                apiKey: OPENAI_ORGANIZATION_KEY,
                inputs: () =>
                    openai
                        .embeddings()
                        .flatMap((call) => call.body.input ?? []),
            },
            {
                provider: 'MISTRAL',
                model: 'mistral-embed',
                dimensions: 1024,
                endpoint: mistral.endpoint,
                apiKey: MISTRAL_ORGANIZATION_KEY,
                inputs: () =>
                    mistral
                        .embeddings()
                        .flatMap((call) => call.body.input ?? []),
            },
        ] as const;
        const source = await fixture.upload(
            parentText,
            'native-parent-context.txt'
        );
        for (const provider of providers) {
            const data =
                provider.provider === 'OLLAMA'
                    ? {
                          provider: provider.provider,
                          endpoint: provider.endpoint,
                          apiKey: null,
                      }
                    : {
                          provider: provider.provider,
                          endpoint: provider.endpoint,
                          apiKey: provider.apiKey,
                      };
            const credential = await f.owner.rag.credentials.create({
                name: `Parent ${provider.provider}`,
                data,
            });
            await f.owner.rag.credentials.activate({ id: credential.id });
            for (const strategy of [
                'DOCUMENT_STRUCTURE',
                'TOKEN_WINDOW',
                'SEMANTIC',
            ] as const) {
                await t.test(
                    `${provider.provider} ${strategy} embeds only children and returns authorized exact parent context`,
                    async () => {
                        const collection = await f.owner.rag.collections.create(
                            {
                                name: `Parent ${provider.provider} ${strategy}`,
                                grantCreatorRead: true,
                                profile: {
                                    provider: provider.provider,
                                    model: provider.model,
                                    dimensions: provider.dimensions,
                                    embeddingPreset: 'GENERIC',
                                    chunkingStrategy: strategy,
                                    parentChild: true,
                                    chunking: parentSizes,
                                },
                            }
                        );
                        assert.equal(
                            collection.configuration.credentialId,
                            credential.id
                        );
                        await f.owner.rag.documents.setCollection({
                            id: source.id,
                            collectionId: collection.id,
                            attached: true,
                        });
                        const started = await f.owner.rag.indexing.start({
                            collectionId: collection.id,
                            expectedRevision: 1,
                            requestId: randomUUID(),
                        });
                        const beforeInputs = provider.inputs().length;
                        await scanParent(fixture, started.generationId, 6);
                        const generation =
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: started.generationId },
                                include: { configuration: true },
                            });
                        assert.equal(generation.status, 'ACTIVE');
                        assert.equal(
                            generation.parentContextVersion,
                            'parent-context-utf8-v1'
                        );
                        assert.equal(
                            generation.configuration.parentChild,
                            true
                        );
                        assert.equal(
                            generation.chunkerVersion,
                            strategy === 'DOCUMENT_STRUCTURE'
                                ? 'structure-utf8-v1'
                                : strategy === 'TOKEN_WINDOW'
                                  ? 'token-window-utf8-v1'
                                  : 'semantic-utf8-v1'
                        );
                        const state = await assertParentPublication(
                            started.generationId,
                            source.id,
                            parentText
                        );
                        const expectedInputs: string[] = [];
                        if (strategy === 'SEMANTIC') {
                            const plan =
                                await prisma.semanticChunkPlan.findUniqueOrThrow(
                                    {
                                        where: {
                                            indexedDocumentId:
                                                state.candidate.id,
                                        },
                                    }
                                );
                            assert.equal(plan.state, 'READY');
                            assert(Array.isArray(plan.unitRanges));
                            for (const range of plan.unitRanges) {
                                assert(
                                    range &&
                                        typeof range === 'object' &&
                                        !Array.isArray(range)
                                );
                                assert(
                                    typeof range.start === 'number' &&
                                        typeof range.end === 'number'
                                );
                                expectedInputs.push(
                                    parentText.slice(range.start, range.end)
                                );
                            }
                            const finalWork =
                                await prisma.embeddingWorkAttempt.findMany({
                                    where: {
                                        indexedDocumentId: state.candidate.id,
                                        purpose: 'FINAL_DOCUMENT',
                                    },
                                });
                            assert(
                                finalWork.every(
                                    (row) => row.state === 'SUCCEEDED'
                                )
                            );
                            assert.equal(
                                finalWork.reduce(
                                    (count, row) => count + row.inputCount,
                                    0
                                ),
                                state.children.length
                            );
                        } else {
                            assert.equal(
                                await prisma.embeddingWorkAttempt.count({
                                    where: {
                                        indexedDocumentId: state.candidate.id,
                                    },
                                }),
                                0
                            );
                        }
                        expectedInputs.push(
                            ...state.children.map((row) => row.text)
                        );
                        assert.deepEqual(
                            provider.inputs().slice(beforeInputs),
                            expectedInputs,
                            'Exact native inputs must contain boundary units where needed and final children, never extra parent embeddings.'
                        );
                        const preview = await f.owner.rag.indexing.chunks({
                            collectionId: collection.id,
                            documentId: source.id,
                            limit: 100,
                        });
                        assert.equal(preview.total, state.children.length);
                        assert(
                            preview.items.every(
                                (row) =>
                                    row.parentContext &&
                                    row.parentContext.ordinal >=
                                        state.children.length
                            )
                        );
                        const result = await f.owner.rag.indexing.search({
                            collectionId: collection.id,
                            query: 'forest',
                            strategy: 'HYBRID',
                            topK: 20,
                            filters: {},
                        });
                        assert(
                            result.results.length > 0 &&
                                result.results.length <= state.parents.length
                        );
                        assert.equal(
                            new Set(
                                result.results.map(
                                    (row) => row.parentContext?.id
                                )
                            ).size,
                            result.results.length
                        );
                        assert(
                            result.results.every(
                                (row) =>
                                    row.parentContext &&
                                    row.documentId === source.id &&
                                    row.version === 1
                            )
                        );
                        const receipt = result.results[0]!.source.receipt;
                        assert.equal(
                            (
                                await f.owner.rag.indexing.sourcePreview({
                                    collectionId: collection.id,
                                    receipt,
                                })
                            ).text,
                            parentText
                        );
                        assert.equal(
                            await (
                                await f.owner.rag.indexing.sourceOriginal({
                                    collectionId: collection.id,
                                    receipt,
                                })
                            ).text(),
                            parentText
                        );
                    }
                );
            }
        }
    } finally {
        const closed = await Promise.allSettled(
            providersToClose.map((provider) => provider.close())
        );
        await fixture.close();
        assert(
            closed.every((result) => result.status === 'fulfilled'),
            'All controlled native provider servers must close.'
        );
    }
}
