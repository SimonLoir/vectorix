import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import {
    resolveCollectionCredential,
    resolveCredential,
} from '@routers/rag/credentials';
import { fixture as f } from './fixtures';
import { cleanParentCollection, createParentFixture } from './parent-fixtures';
import { scanSemantic } from './semantic-fixtures';

const environmentKeys = [
    'VECTORIX_DEFAULT_S3_ENDPOINT',
    'VECTORIX_S3_ALLOWED_ENDPOINTS',
    'VECTORIX_DEFAULT_OLLAMA_ENDPOINT',
    'VECTORIX_DEFAULT_COHERE_ENDPOINT',
    'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS',
] as const;
const invalidEntry = 'PRIVATE_OPERATOR_ENTRY_WITHOUT_A_URL';

function sha256(value: Uint8Array | string) {
    return createHash('sha256').update(value).digest('hex');
}

/** Real S3 and native HTTP protocols use existing isolated fixtures; their embedding vectors are synthetic. */
export async function endpointAllowlistTests(t: TestContext) {
    assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'));
    const previous = new Map(
        environmentKeys.map((key) => [key, process.env[key]])
    );
    const fixture = await createParentFixture('Endpoint allowlists', true);
    const storageEndpoint = process.env.VECTORIX_DEFAULT_S3_ENDPOINT!;
    const collections: string[] = [];
    const generations: string[] = [];
    const documents: string[] = [];
    try {
        const collection = await fixture.collection(
            'Allowlisted saved destination'
        );
        collections.push(collection.id);
        const text =
            'Approved endpoint preserves an immutable bilingual source. Endpoint autorisé, source conservée.\n'.repeat(
                3
            );
        let documentId = '';
        let sourceVersionId = '';
        let publicationId = '';
        const search = (strategy: 'LEXICAL' | 'VECTOR') =>
            f.owner.rag.indexing.search({
                collectionId: collection.id,
                query: 'approved',
                strategy,
                topK: 3,
                filters: {},
            });
        // Organization credentials already exist. Removing platform endpoints is
        // essential: their automatic admission must not mask malformed CSV order.
        delete process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
        delete process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT;
        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = `${invalidEntry},${storageEndpoint}`;
        process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${invalidEntry},${fixture.endpoint}`;

        await t.test(
            'a later valid S3 endpoint supports upload and saved-source reads independently of malformed-entry order',
            async () => {
                const uploaded = await fixture.upload(
                    text,
                    'allowlisted-source.txt',
                    collection.id
                );
                documentId = uploaded.id;
                documents.push(uploaded.id);
                const details = await f.owner.rag.documents.details({
                    id: documentId,
                });
                assert.equal(details.document.status, 'READY');
                assert.ok(details.version);
                sourceVersionId = details.version.id;
                const stored = await prisma.documentVersion.findFirstOrThrow({
                    where: {
                        id: sourceVersionId,
                        organizationId: fixture.organizationId,
                    },
                    include: { storageLocation: true, extraction: true },
                });
                assert.equal(stored.status, 'READY');
                assert.equal(stored.storageLocation.endpoint, storageEndpoint);
                assert.ok(
                    stored.storageLocation.credentialId,
                    'The upload must use an organization storage binding, not platform fallback.'
                );
                assert.ok(stored.extraction);
                assert.equal(
                    (await f.owner.rag.documents.preview({ id: documentId }))
                        .text,
                    text
                );
                assert.equal(
                    sha256(
                        new Uint8Array(
                            await (
                                await f.owner.rag.documents.download({
                                    id: documentId,
                                })
                            ).arrayBuffer()
                        )
                    ),
                    sha256(text)
                );
                process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = `${storageEndpoint},${invalidEntry}`;
                assert.equal(
                    (await f.owner.rag.documents.preview({ id: documentId }))
                        .text,
                    text
                );
                for (const session of [f.reader, f.other]) {
                    await assert.rejects(
                        session.rag.documents.download({ id: documentId }),
                        { code: 'NOT_FOUND' }
                    );
                }
                const before = await prisma.documentVersion.count({
                    where: {
                        organizationId: fixture.organizationId,
                        documentId,
                    },
                });
                process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = invalidEntry;
                await assert.rejects(
                    f.owner.rag.documents.download({ id: documentId }),
                    { code: 'INTERNAL_SERVER_ERROR' }
                );
                assert.equal(
                    await prisma.documentVersion.count({
                        where: {
                            organizationId: fixture.organizationId,
                            documentId,
                        },
                    }),
                    before
                );
                assert.equal(
                    (
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: sourceVersionId },
                        })
                    ).sha256,
                    stored.sha256
                );
                process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = `${invalidEntry},${storageEndpoint}`;
                assert.equal(
                    (await f.owner.rag.documents.preview({ id: documentId }))
                        .text,
                    text
                );
            }
        );

        await t.test(
            'a later approved embedding endpoint supports real discovery, probe, indexing and both retrieval branches',
            async () => {
                assert.ok(documentId && sourceVersionId);
                const models = await f.owner.rag.indexing.models({
                    collectionId: collection.id,
                    expectedRevision: 1,
                });
                assert.ok(
                    models.items.some(
                        (model) => model.model === 'fixture:latest'
                    )
                );
                const probe = await f.owner.rag.indexing.probe({
                    collectionId: collection.id,
                    expectedRevision: 1,
                });
                assert.equal(probe.provider, 'OLLAMA');
                assert.equal(probe.dimensions, 3);
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                generations.push(started.generationId);
                await scanSemantic(fixture, started.generationId, 8);
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: collection.id,
                        })
                    ).active?.id,
                    started.generationId
                );
                const publication =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: {
                            organizationId: fixture.organizationId,
                            generationId: started.generationId,
                            documentId,
                            status: 'PUBLISHED',
                        },
                        include: { sourceHold: true },
                    });
                publicationId = publication.id;
                assert.equal(publication.sourceVersionId, sourceVersionId);
                assert.equal(publication.sourceHold?.state, 'LIVE');
                assert.equal(
                    publication.sourceHold?.versionId,
                    sourceVersionId
                );
                for (const strategy of ['LEXICAL', 'VECTOR'] as const) {
                    const found = (await search(strategy)).results.find(
                        (result) => result.documentId === documentId
                    );
                    assert.ok(
                        found,
                        'The real published source must remain retrievable.'
                    );
                    assert.equal(found.version, 1);
                    assert.equal(found.generationId, started.generationId);
                }
                assert.ok(
                    fixture.state.embedCalls > 0,
                    'Probes/index/query must use the controlled native HTTP provider.'
                );
                await assert.rejects(
                    f.other.rag.indexing.models({
                        collectionId: collection.id,
                    }),
                    { code: 'NOT_FOUND' }
                );
            }
        );

        await t.test(
            'mutable policy snapshots retain provider separation and saved bindings without falling back from a rejected organization selection',
            async () => {
                assert.ok(publicationId);
                const revision =
                    await prisma.collectionConfigRevision.findFirstOrThrow({
                        where: {
                            organizationId: fixture.organizationId,
                            collectionId: collection.id,
                            revision: 1,
                        },
                    });
                assert.ok(revision.credentialId);
                assert.equal(revision.endpoint, fixture.endpoint);
                const before = fixture.state.embedCalls;
                // Another provider's platform endpoint must never approve OLLAMA.
                process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT = fixture.endpoint;
                process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = invalidEntry;
                for (const operation of [
                    () =>
                        f.owner.rag.indexing.models({
                            collectionId: collection.id,
                        }),
                    () =>
                        f.owner.rag.indexing.probe({
                            collectionId: collection.id,
                            expectedRevision: 1,
                        }),
                    () => search('VECTOR'),
                ])
                    await assert.rejects(operation(), {
                        code: 'CONFLICT',
                        data: { errorCode: 'CREDENTIALS_INVALID' },
                    });
                assert.equal(
                    fixture.state.embedCalls,
                    before,
                    'Policy denial must occur before an embedding request.'
                );
                assert.equal(
                    (await search('LEXICAL')).results.find(
                        (result) => result.documentId === documentId
                    )?.version,
                    1
                );
                process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${fixture.endpoint},${invalidEntry}`;
                assert.ok(
                    (await search('VECTOR')).results.some(
                        (result) => result.documentId === documentId
                    )
                );

                const rejected = await f.owner.rag.credentials.create({
                    name: 'Unapproved organization destination',
                    data: {
                        provider: 'OLLAMA',
                        endpoint: 'http://unapproved-organization.test:11434',
                        apiKey: null,
                    },
                });
                await f.owner.rag.credentials.activate({ id: rejected.id });
                assert.equal(
                    (
                        await resolveCredential(
                            prisma,
                            fixture.organizationId,
                            'OLLAMA'
                        )
                    ).credentialId,
                    rejected.id
                );
                assert.equal(
                    (
                        await resolveCollectionCredential(
                            prisma,
                            fixture.organizationId,
                            collection.id,
                            1
                        )
                    ).credentialId,
                    revision.credentialId
                );
                process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT = fixture.endpoint;
                const current = await f.owner.rag.collections.create({
                    name: 'Rejected current organization binding',
                    grantCreatorRead: true,
                    profile: {
                        provider: 'OLLAMA',
                        model: 'fixture:latest',
                        dimensions: 3,
                    },
                });
                collections.push(current.id);
                assert.equal(current.configuration.credentialId, rejected.id);
                const calls = fixture.state.embedCalls;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: current.id,
                        expectedRevision: 1,
                    }),
                    {
                        code: 'CONFLICT',
                        data: { errorCode: 'CREDENTIALS_INVALID' },
                    }
                );
                assert.equal(
                    fixture.state.embedCalls,
                    calls,
                    'A valid platform fallback must not rescue the rejected organization binding.'
                );
                assert.ok(
                    (
                        await f.owner.rag.indexing.models({
                            collectionId: collection.id,
                        })
                    ).items.some((model) => model.model === 'fixture:latest')
                );
                assert.ok(
                    (await search('VECTOR')).results.some(
                        (result) => result.documentId === documentId
                    )
                );
                const unchanged =
                    await prisma.collectionConfigRevision.findFirstOrThrow({
                        where: {
                            organizationId: fixture.organizationId,
                            collectionId: collection.id,
                            revision: 1,
                        },
                    });
                assert.equal(unchanged.credentialId, revision.credentialId);
                assert.equal(unchanged.endpoint, revision.endpoint);
                assert.equal(
                    (
                        await prisma.generationDocument.findFirstOrThrow({
                            where: {
                                organizationId: fixture.organizationId,
                                generationId: generations[0]!,
                                documentId,
                            },
                        })
                    ).publishedIndexedDocumentId,
                    publicationId
                );
            }
        );
    } finally {
        // Real cleaners still need their original saved endpoints admitted.
        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = storageEndpoint;
        process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = fixture.endpoint;
        try {
            for (const id of collections)
                await cleanParentCollection(
                    fixture,
                    id,
                    id === collections[0] ? generations : []
                );
            for (const id of documents) {
                const latest = await prisma.documentVersion.findFirstOrThrow({
                    where: {
                        organizationId: fixture.organizationId,
                        documentId: id,
                    },
                    orderBy: { version: 'desc' },
                });
                await f.owner.rag.documents.delete({
                    id,
                    expectedVersionId: latest.id,
                    retentionDays: 0,
                });
                for (let pass = 0; pass < 12; pass++) {
                    await prisma.documentIngestion.updateMany({
                        where: {
                            organizationId: fixture.organizationId,
                            version: { documentId: id },
                        },
                        data: { leasedUntil: new Date(0) },
                    });
                    await prisma.documentCleanup.updateMany({
                        where: {
                            organizationId: fixture.organizationId,
                            version: { documentId: id },
                            status: { not: 'COMPLETE' },
                        },
                        data: {
                            scheduledAt: new Date(0),
                            availableAt: new Date(0),
                            leasedUntil: new Date(0),
                        },
                    });
                    await processDocumentCleanups(prisma);
                    if (
                        !(await prisma.documentCleanup.count({
                            where: {
                                organizationId: fixture.organizationId,
                                version: { documentId: id },
                                status: { not: 'COMPLETE' },
                            },
                        }))
                    )
                        break;
                }
                assert.equal(
                    await prisma.documentCleanup.count({
                        where: {
                            organizationId: fixture.organizationId,
                            version: { documentId: id },
                            status: { not: 'COMPLETE' },
                        },
                    }),
                    0,
                    'The isolated allowlist source must finish real cleanup.'
                );
            }
        } finally {
            try {
                await fixture.close();
            } finally {
                for (const [key, value] of previous) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            }
        }
    }
}
