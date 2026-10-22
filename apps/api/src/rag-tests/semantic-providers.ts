import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';
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

/**
 * Exercise native hosted-provider dispatch with semantic boundaries, real catalog,
 * vector and object persistence. All embedding responses are local synthetic
 * fixtures; this does not establish paid-provider connectivity or relevance.
 */
export async function semanticProviderTests(t: TestContext) {
    const previous = { organization: f.org, owner: f.ownerMember };
    const environment = new Map([
        [
            'VECTORIX_DEFAULT_OLLAMA_ENDPOINT',
            process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
        ],
        [
            'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS',
            process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS,
        ],
    ]);
    const providersToClose: { close(): Promise<void> }[] = [];
    let indexing: Awaited<ReturnType<typeof createIndexingFixture>> | undefined;
    try {
        const organization: unknown = await f.owner.post(
            'organization/create',
            {
                name: `Native semantic boundaries ${randomUUID()}`,
                slug: `native-semantic-${randomUUID()}`,
            }
        );
        assert(
            organization &&
                typeof organization === 'object' &&
                'id' in organization &&
                typeof organization.id === 'string'
        );
        await f.owner.post('organization/set-active', {
            organizationId: organization.id,
        });
        f.org = organization.id;
        f.ownerMember = (await f.owner.client.admin.members.me({})).id;
        assert.equal(
            await prisma.member.count({ where: { organizationId: f.org } }),
            1
        );
        const fixture = await createIndexingFixture();
        indexing = fixture;

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

        const providers = [
            {
                provider: 'COHERE',
                model: 'embed-v4.0',
                dimensions: 256,
                schemaVersion: 2,
                endpoint: cohere.endpoint,
                apiKey: COHERE_ORGANIZATION_KEY,
                calls: () => cohere.state.calls,
            },
            {
                provider: 'VOYAGE',
                model: 'voyage-4',
                dimensions: 256,
                schemaVersion: 3,
                endpoint: voyage.endpoint,
                apiKey: VOYAGE_ORGANIZATION_KEY,
                calls: () => voyage.state.calls,
            },
            {
                provider: 'OPENAI',
                model: 'text-embedding-3-small',
                dimensions: 257,
                schemaVersion: 4,
                endpoint: openai.endpoint,
                apiKey: OPENAI_ORGANIZATION_KEY,
                calls: () => openai.state.calls,
            },
            {
                provider: 'MISTRAL',
                model: 'mistral-embed',
                dimensions: 1024,
                schemaVersion: 5,
                endpoint: mistral.endpoint,
                apiKey: MISTRAL_ORGANIZATION_KEY,
                calls: () => mistral.state.calls,
            },
        ] as const;
        const identities = new Set<string>();
        const text =
            'Les renards vivent dans la forêt. Le café accompagne cette lecture française. ' +
            'Solar energy supports the forest and keeps this English context searchable. ' +
            'Une fenêtre conserve les positions exactes du texte, même après une frontière. ' +
            'The final forest passage stays available with its original source document. ' +
            'Les sources restent immuables et la recherche retrouve le contexte bilingue.';
        assert(text.length >= 300 && text.length <= 500);

        for (const provider of providers) {
            await t.test(
                `${provider.provider} semantic boundaries publish native snapshots and hybrid results with exact original sources`,
                async () => {
                    const credential = await f.owner.rag.credentials.create({
                        name: `Semantic ${provider.provider}`,
                        data: {
                            provider: provider.provider,
                            endpoint: provider.endpoint,
                            apiKey: provider.apiKey,
                        },
                    });
                    await f.owner.rag.credentials.activate({
                        id: credential.id,
                    });
                    const collection = await f.owner.rag.collections.create({
                        name: `${provider.provider} semantic boundaries`,
                        grantCreatorRead: true,
                        profile: {
                            provider: provider.provider,
                            model: provider.model,
                            dimensions: provider.dimensions,
                            embeddingPreset: 'GENERIC',
                            chunkingStrategy: 'SEMANTIC',
                            parentChild: false,
                            chunking: {
                                targetTokens: 32,
                                minTokens: 16,
                                maxTokens: 48,
                                overlapTokens: 4,
                                semanticPercentile: 75,
                            },
                        },
                    });
                    assert.equal(
                        collection.configuration.credentialId,
                        credential.id
                    );
                    const document = await fixture.upload(
                        text,
                        `semantic-${provider.provider.toLowerCase()}.txt`,
                        collection.id
                    );
                    const started = await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: collection.configurationRevision,
                        requestId: randomUUID(),
                    });
                    await fixture.scan(6);
                    const status = await f.owner.rag.indexing.status({
                        collectionId: collection.id,
                    });
                    assert.equal(status.active?.id, started.generationId);
                    assert.equal(status.unsupportedReason, null);
                    const generation =
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        });
                    assert.equal(generation.status, 'ACTIVE');
                    assert.equal(generation.chunkerVersion, 'semantic-utf8-v1');
                    assert.equal(
                        status.active?.dimensions,
                        provider.dimensions
                    );
                    const snapshot = generation.capabilitySnapshot;
                    assert(
                        snapshot &&
                            typeof snapshot === 'object' &&
                            !Array.isArray(snapshot)
                    );
                    assert.equal(
                        snapshot.schemaVersion,
                        provider.schemaVersion
                    );
                    assert.equal(snapshot.provider, provider.provider);
                    assert.equal(snapshot.model, provider.model);
                    assert.equal(snapshot.dimensions, provider.dimensions);
                    assert.equal(snapshot.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(snapshot.digest, generation.modelIdentity);
                    assert(!identities.has(generation.modelIdentity));
                    identities.add(generation.modelIdentity);

                    const candidate =
                        await prisma.indexedDocument.findFirstOrThrow({
                            where: {
                                generationId: started.generationId,
                                documentId: document.id,
                            },
                        });
                    const plan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: { indexedDocumentId: candidate.id },
                        });
                    assert.equal(plan.state, 'READY');
                    assert.equal(plan.completedUnits, plan.unitCount);
                    assert(plan.unitCount > 1);
                    assert.equal(plan.lastUnitVector, null);
                    const work = await prisma.embeddingWorkAttempt.findMany({
                        where: { indexedDocumentId: candidate.id },
                    });
                    assert(
                        work.some(
                            (row) =>
                                row.purpose === 'BOUNDARY' &&
                                row.state === 'SUCCEEDED'
                        )
                    );
                    assert(
                        work.some(
                            (row) =>
                                row.purpose === 'FINAL_DOCUMENT' &&
                                row.state === 'SUCCEEDED'
                        )
                    );
                    assert(
                        work.every(
                            (row) =>
                                row.reservedPreparedBytes === 0n &&
                                row.reservedBatches === 0
                        )
                    );
                    const chunks = await f.owner.rag.indexing.chunks({
                        collectionId: collection.id,
                        generationId: started.generationId,
                        documentId: document.id,
                        limit: 100,
                    });
                    assert(chunks.total > 1 && chunks.total < 100);
                    assert.equal(chunks.items.length, chunks.total);
                    assert(
                        chunks.items.every(
                            (chunk) =>
                                chunk.published &&
                                chunk.tokenCountIsEstimate &&
                                chunk.version === 1 &&
                                chunk.sourceSpans.length > 0
                        )
                    );
                    const beforeSearch = provider.calls().length;
                    const result = await f.owner.rag.indexing.search({
                        collectionId: collection.id,
                        query: 'forest',
                        strategy: 'HYBRID',
                        topK: 20,
                        filters: {},
                    });
                    assert.equal(result.generationId, started.generationId);
                    assert(result.results.length > 0);
                    assert(
                        result.results.every(
                            (item) =>
                                item.documentId === document.id &&
                                item.version === 1
                        )
                    );
                    assert(
                        result.results.some(
                            (item) => item.scores.lexicalRank !== null
                        )
                    );
                    assert(
                        result.results.some(
                            (item) => item.scores.vectorRank !== null
                        )
                    );
                    assert(
                        provider.calls().length > beforeSearch,
                        'Hybrid search must invoke the saved native query provider.'
                    );
                    assert(
                        provider
                            .calls()
                            .every(
                                (call) =>
                                    call.authorization ===
                                    `Bearer ${provider.apiKey}`
                            ),
                        'Native calls must keep the organization credential binding.'
                    );
                    const receipt = result.results[0]!.source.receipt;
                    const preview = await f.owner.rag.indexing.sourcePreview({
                        collectionId: collection.id,
                        receipt,
                    });
                    assert.equal(preview.version, 1);
                    assert.equal(preview.text, text);
                    const original = await f.owner.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    });
                    assert.equal(await original.text(), text);
                }
            );
        }
    } finally {
        const closed = await Promise.allSettled([
            ...providersToClose.map((provider) => provider.close()),
            ...(indexing ? [indexing.close()] : []),
        ]);
        for (const [key, value] of environment) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        f.org = previous.organization;
        f.ownerMember = previous.owner;
        await f.owner.post('organization/set-active', {
            organizationId: f.org,
        });
        assert(
            closed.every((result) => result.status === 'fulfilled'),
            'Controlled provider fixtures and vector adapters must close.'
        );
    }
}
