import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import {
    processCollectionIndexing,
    closeVectorAdapters,
} from '@routers/rag/indexing';
import { fixture as f } from './fixtures';

/** Controlled native HTTP provider; vectors are synthetic and never evidence of real-model quality. */
export async function createIndexingFixture() {
    const state: {
        rejectEmbeddings: boolean;
        digest: string;
        embedCalls: number;
        vectorForText?: (text: string) => number[];
        beforeEmbedding?: () => Promise<void>;
    } = { rejectEmbeddings: false, digest: 'a'.repeat(64), embedCalls: 0 };
    const server = createServer(async (request, response) => {
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const body = parts.length
            ? (JSON.parse(Buffer.concat(parts).toString()) as {
                  input?: string[];
                  truncate?: boolean;
              })
            : {};
        response.setHeader('content-type', 'application/json');
        switch (request.url) {
            case '/api/tags': {
                response.end(
                    JSON.stringify({
                        models: [
                            {
                                name: 'fixture:latest',
                                model: 'fixture:latest',
                                digest: state.digest,
                                details: { family: 'bert' },
                            },
                        ],
                    })
                );
                break;
            }
            case '/api/show': {
                response.end(
                    JSON.stringify({
                        details: { family: 'bert' },
                        capabilities: ['embedding'],
                        ['model_info']: {
                            'general.architecture': 'bert',
                            'bert.context_length': 2048,
                            'bert.embedding_length': 3,
                        },
                    })
                );
                break;
            }
            case '/api/embed': {
                state.embedCalls++;
                assert.equal(body.truncate, false);
                await state.beforeEmbedding?.();
                if (state.rejectEmbeddings) {
                    response.writeHead(400);
                    response.end(
                        JSON.stringify({
                            error: 'synthetic-private-provider-body',
                        })
                    );
                } else
                    response.end(
                        JSON.stringify({
                            model: 'fixture:latest',
                            embeddings: body.input!.map(
                                (text) =>
                                    state.vectorForText?.(text) ?? [
                                        1 +
                                            (text.match(
                                                /fox|renard|animals|animaux/gi
                                            )?.length ?? 0),
                                        1 +
                                            (text.match(
                                                /solar|solaire|energy|énergie/gi
                                            )?.length ?? 0),
                                        1,
                                    ]
                            ),
                            ['prompt_eval_count']: body.input!.length * 5,
                        })
                    );

                break;
            }
            default: {
                response.writeHead(404);
                response.end('{}');
            }
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const prior = {
        endpoint: process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
        allowed: process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS,
    };
    process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT = endpoint;
    process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = endpoint;
    const storage = await f.owner.rag.credentials.create({
        name: `Index storage ${randomUUID()}`,
        data: {
            provider: 'S3',
            endpoint: process.env.VECTORIX_DEFAULT_S3_ENDPOINT!,
            region: 'us-east-1',
            bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET!,
            accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
            forcePathStyle: true,
        },
    });
    await f.owner.rag.credentials.activate({ id: storage.id });
    const credential = await f.owner.rag.credentials.create({
        name: `Index embeddings ${randomUUID()}`,
        data: { provider: 'OLLAMA', endpoint, apiKey: null },
    });
    await f.owner.rag.credentials.activate({ id: credential.id });
    const priorQuota = await prisma.organizationQuota.findUnique({
        where: { organizationId: f.org },
    });
    const fixtureQuota = {
        collections: 1000,
        documents: 10_000,
        originalBytes: 25n * 1024n ** 2n,
        storageBytes: 10n * 1024n ** 3n,
        chunksPerCollection: 100_000,
        temporaryChunksPerCollection: 100_000,
    };
    await prisma.organizationQuota.upsert({
        where: { organizationId: f.org },
        create: { organizationId: f.org, ...fixtureQuota },
        update: fixtureQuota,
    });
    await processCollectionIndexing(prisma);
    return {
        state,
        endpoint,
        collection: (name = `Index ${randomUUID()}`) =>
            f.owner.rag.collections.create({
                name,
                description: '',
                grantCreatorRead: true,
                profile: {
                    provider: 'OLLAMA',
                    model: 'fixture:latest',
                    dimensions: 3,
                },
            }),
        async upload(text: string, name: string, collectionId?: string) {
            const upload = await f.owner.rag.documents.upload({
                requestId: randomUUID(),
                file: new File([text], name),
            });
            await processDocumentIngestions(prisma);
            if (collectionId)
                await f.owner.rag.documents.setCollection({
                    id: upload.id,
                    collectionId,
                    attached: true,
                });
            return f.owner.rag.documents.get({ id: upload.id });
        },
        async scan(times = 4) {
            for (let pass = 0; pass < times; pass++)
                await processCollectionIndexing(prisma);
        },
        async close() {
            await (priorQuota ? prisma.organizationQuota.update({
                    where: { organizationId: f.org },
                    data: {
                        collections: priorQuota.collections,
                        documents: priorQuota.documents,
                        originalBytes: priorQuota.originalBytes,
                        storageBytes: priorQuota.storageBytes,
                        chunksPerCollection: priorQuota.chunksPerCollection,
                        temporaryChunksPerCollection:
                            priorQuota.temporaryChunksPerCollection,
                    },
                }) : prisma.organizationQuota.deleteMany({
                    where: { organizationId: f.org },
                }));
            if (prior.endpoint === undefined)
                delete process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT;
            else process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT = prior.endpoint;
            if (prior.allowed === undefined)
                delete process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS;
            else
                process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS =
                    prior.allowed;
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await closeVectorAdapters();
        },
    };
}
