import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { app } from '../app';
import { fixture as f, readGrant, rpc } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';

/** Controlled native HTTP + real vector/FTS/S3 paths; this does not claim live-provider relevance quality. */
export async function indexSearchTests(t: TestContext) {
    const fixture = await createIndexingFixture();
    try {
        const collection = await fixture.collection(`Search ${randomUUID()}`);
        const savedProfile = collectionProfile
            .strip()
            .parse(collection.configuration);
        const configured = await f.owner.rag.collections.update({
            id: collection.id,
            expectedRevision: collection.configurationRevision,
            name: collection.name,
            description: collection.description,
            profile: {
                ...savedProfile,
                metadataFields: {
                    category: 'STRING',
                    priority: 'NUMBER',
                    approved: 'BOOLEAN',
                    published: 'DATE',
                },
            },
        });
        const collectionId = collection.id;
        const frenchText =
            'Les chevaux galopent dans les jardins fleuris. shared exclusive.\n';
        const englishText =
            'The runners were running through the beautiful gardens. shared.\n';
        const french = await fixture.upload(
            frenchText,
            'search-fr.txt',
            collectionId
        );
        const english = await fixture.upload(
            englishText,
            'search-en.txt',
            collectionId
        );
        const frenchVersionId = (
            await f.owner.rag.documents.details({ id: french.id })
        ).version!.id;
        for (let index = 0; index < 8; index++)
            await fixture.upload(
                `shared shared shared. Excluded candidate ${index}.\n`,
                `search-excluded-${index}.txt`,
                collectionId
            );
        await f.owner.rag.indexing.updateMetadata({
            collectionId,
            documentId: french.id,
            expectedMetadataRevision: 1,
            language: 'FR',
            tags: ['approved', 'legal'],
            metadata: {
                category: 'legal',
                priority: 12,
                approved: true,
                published: '2026-10-12T00:00:00Z',
            },
        });
        await f.owner.rag.indexing.updateMetadata({
            collectionId,
            documentId: english.id,
            expectedMetadataRevision: 1,
            language: 'EN',
            tags: ['public'],
            metadata: {
                category: 'public',
                priority: 2,
                approved: false,
                published: '2025-01-01T00:00:00Z',
            },
        });
        fixture.state.vectorForText = (text) =>
            text.includes('exclusive') ? [0, 1, 0] : [1, 0, 0];
        const started = await f.owner.rag.indexing.start({
            collectionId,
            expectedRevision: configured.configurationRevision,
            requestId: randomUUID(),
        });
        await fixture.scan(8);
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId })).active?.id,
            started.generationId
        );
        const search = (
            query: string,
            strategy: 'HYBRID' | 'LEXICAL' | 'VECTOR' = 'HYBRID'
        ) =>
            f.owner.rag.indexing.search({
                collectionId,
                query,
                strategy,
                topK: 20,
                filters: {},
            });
        let sourceReceipt = '';
        await t.test(
            'real French and English stemming finds published source spans and both rank branches fuse deterministically',
            async () => {
                const fr = await search('cheval', 'LEXICAL');
                assert(
                    fr.results.some((item) => item.documentId === french.id)
                );
                assert(
                    fr.results.every(
                        (item) =>
                            item.scores.lexicalRank !== null &&
                            item.scores.vectorRank === null
                    )
                );
                const en = await search('run', 'LEXICAL');
                assert(
                    en.results.some((item) => item.documentId === english.id)
                );
                const hybrid = await search('shared');
                assert(hybrid.results.length >= 2);
                for (const result of hybrid.results) {
                    assert.equal(result.published, true);
                    assert.equal(result.version, 1);
                    assert.equal(
                        result.language === 'FR' ||
                            result.language === 'EN' ||
                            result.language === 'UNDETERMINED',
                        true
                    );
                    assert(result.sourceSpans.length > 0);
                    for (const span of result.sourceSpans) {
                        assert(span.start >= span.source.start);
                        assert(span.end <= span.source.end);
                        assert(span.end > span.start);
                    }
                    const expected =
                        (result.scores.lexicalRank === null
                            ? 0
                            : 1 / (60 + result.scores.lexicalRank)) +
                        (result.scores.vectorRank === null
                            ? 0
                            : 1 / (60 + result.scores.vectorRank));
                    assert(Math.abs(result.scores.rrf - expected) < 1e-12);
                }
                const result = hybrid.results.find(
                    (item) => item.documentId === french.id
                )!;
                sourceReceipt = result.source.receipt;
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                            offset: 0,
                        })
                    ).text,
                    frenchText
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text(),
                    frenchText
                );
                const chunks = await f.owner.rag.indexing.chunks({
                    collectionId,
                    documentId: french.id,
                    limit: 1,
                });
                assert.equal(chunks.total, 1);
                assert.equal(chunks.items[0]?.id, result.id);
            }
        );
        await t.test(
            'typed metadata, dates, tags, language, format and document filters apply before vector/FTS candidate limits',
            async () => {
                for (const strategy of [
                    'VECTOR',
                    'LEXICAL',
                    'HYBRID',
                ] as const) {
                    const result = await f.owner.rag.indexing.search({
                        collectionId,
                        query: 'shared',
                        strategy,
                        topK: 1,
                        filters: {
                            documentIds: [french.id],
                            languages: ['FR'],
                            mediaTypes: ['text/plain'],
                            tags: ['approved', 'legal'],
                            createdAfter: new Date(Date.now() - 86_400_000),
                            createdBefore: new Date(Date.now() + 86_400_000),
                            metadata: [
                                {
                                    field: 'category',
                                    operator: 'IN',
                                    value: ['legal', 'private'],
                                },
                                {
                                    field: 'priority',
                                    operator: 'GTE',
                                    value: 10,
                                },
                                {
                                    field: 'priority',
                                    operator: 'LTE',
                                    value: 20,
                                },
                                {
                                    field: 'approved',
                                    operator: 'EQ',
                                    value: true,
                                },
                                {
                                    field: 'published',
                                    operator: 'GTE',
                                    value: '2026-10-01T00:00:00Z',
                                },
                            ],
                        },
                    });
                    assert.equal(result.results.length, 1);
                    assert.equal(result.results[0]?.documentId, french.id);
                    const individualFilters = [
                        { languages: ['FR' as const] },
                        { tags: ['legal'] },
                        {
                            metadata: [
                                {
                                    field: 'category',
                                    operator: 'EQ' as const,
                                    value: 'legal',
                                },
                            ],
                        },
                        {
                            metadata: [
                                {
                                    field: 'priority',
                                    operator: 'GTE' as const,
                                    value: 10,
                                },
                            ],
                        },
                        {
                            metadata: [
                                {
                                    field: 'approved',
                                    operator: 'EQ' as const,
                                    value: true,
                                },
                            ],
                        },
                        {
                            metadata: [
                                {
                                    field: 'published',
                                    operator: 'GTE' as const,
                                    value: '2026-10-01T00:00:00Z',
                                },
                            ],
                        },
                    ];
                    for (const filters of individualFilters) {
                        const filtered = await f.owner.rag.indexing.search({
                            collectionId,
                            query: 'shared',
                            strategy,
                            topK: 1,
                            filters,
                        });
                        assert.equal(filtered.results.length, 1);
                        assert.equal(
                            filtered.results[0]?.documentId,
                            french.id
                        );
                    }
                    for (const filters of [
                        { mediaTypes: ['application/pdf'] },
                        { createdBefore: new Date('2000-01-01') },
                    ]) {
                        const excluded = await f.owner.rag.indexing.search({
                            collectionId,
                            query: 'shared',
                            strategy,
                            topK: 1,
                            filters,
                        });
                        assert.equal(excluded.results.length, 0);
                    }
                }
                const none = await f.owner.rag.indexing.search({
                    collectionId,
                    query: 'shared',
                    strategy: 'HYBRID',
                    topK: 10,
                    filters: { tags: ['not-present'] },
                });
                assert.deepEqual(none.results, []);
                for (const metadata of [
                    [{ field: 'unknown', operator: 'EQ' as const, value: 'x' }],
                    [
                        {
                            field: 'priority',
                            operator: 'EQ' as const,
                            value: '12',
                        },
                    ],
                    [
                        {
                            field: 'category',
                            operator: 'GTE' as const,
                            value: 'a',
                        },
                    ],
                    [
                        {
                            field: 'published',
                            operator: 'EQ' as const,
                            value: '2026-02-30T00:00:00Z',
                        },
                    ],
                ])
                    await assert.rejects(
                        f.owner.rag.indexing.search({
                            collectionId,
                            query: 'shared',
                            topK: 1,
                            strategy: 'HYBRID',
                            filters: { metadata },
                        }),
                        { code: 'BAD_REQUEST' }
                    );
            }
        );
        await t.test(
            'required embedding failure rejects the complete hybrid search instead of silently returning keyword results',
            async () => {
                fixture.state.rejectEmbeddings = true;
                try {
                    const lexical = await search('cheval', 'LEXICAL');
                    assert(
                        lexical.results.some(
                            (item) => item.documentId === french.id
                        )
                    );
                    await assert.rejects(
                        search('cheval', 'HYBRID'),
                        (error: unknown) => {
                            assert(
                                error &&
                                    typeof error === 'object' &&
                                    'data' in error
                            );
                            assert.deepEqual(error.data, {
                                errorCode: 'PROVIDER_REJECTED',
                            });
                            assert(
                                !JSON.stringify(error).includes(
                                    'fixture-private-key'
                                )
                            );
                            return true;
                        }
                    );
                } finally {
                    fixture.state.rejectEmbeddings = false;
                }
            }
        );
        await t.test(
            'MAC tampering, expiration and collection/organization substitution never authorize source reads',
            async () => {
                assert(sourceReceipt);
                const [body, signature] = sourceReceipt.split('.');
                assert(body && signature);
                const tampered = `${body}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
                const payload = JSON.parse(
                    Buffer.from(body, 'base64url').toString()
                ) as Record<string, unknown>;
                const ttl =
                    Number(payload.expiresAt) - Number(payload.issuedAt);
                payload.issuedAt = Date.now() - ttl - 10_000;
                payload.expiresAt = Number(payload.issuedAt) + ttl;
                const expiredBody = Buffer.from(
                    JSON.stringify(payload)
                ).toString('base64url');
                const key = createHmac('sha256', process.env.ENCRYPTION_SECRET!)
                    .update('vectorix-index-source-receipt-v1')
                    .digest();
                const expired = `${expiredBody}.${createHmac('sha256', key).update(expiredBody).digest('base64url')}`;
                const second = await fixture.collection(
                    `Receipt scope ${randomUUID()}`
                );
                for (const receipt of [
                    tampered,
                    expired,
                    `${sourceReceipt}.extra`,
                    'malformed',
                ]) {
                    await assert.rejects(
                        f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt,
                            offset: 0,
                        })
                    );
                    await assert.rejects(
                        f.owner.rag.indexing.sourceOriginal({
                            collectionId,
                            receipt,
                        })
                    );
                }
                await assert.rejects(
                    f.owner.rag.indexing.sourcePreview({
                        collectionId: second.id,
                        receipt: sourceReceipt,
                        offset: 0,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.sourcePreview({
                        collectionId,
                        receipt: sourceReceipt,
                        offset: 0,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.search({
                        collectionId,
                        query: 'shared',
                        strategy: 'LEXICAL',
                        topK: 1,
                        filters: {},
                    })
                );
            }
        );
        await t.test(
            'catalog manageAll never grants content; group and API-key issuer revocation affect search and exact sources immediately',
            async () => {
                await assert.rejects(
                    f.manager.rag.indexing.search({
                        collectionId,
                        query: 'shared',
                        strategy: 'LEXICAL',
                        topK: 1,
                        filters: {},
                    })
                );
                await assert.rejects(
                    f.manager.rag.indexing.chunks({ collectionId })
                );
                await assert.rejects(
                    f.manager.rag.indexing.sourceOriginal({
                        collectionId,
                        receipt: sourceReceipt,
                    })
                );
                const group = await f.owner.rag.groups.create({
                    name: `Search readers ${randomUUID()}`,
                });
                await f.owner.rag.groups.addMember({
                    id: group.id,
                    memberId: f.readerMember,
                });
                await f.owner.rag.collections.setGrant({
                    id: collectionId,
                    target: { type: 'group', id: group.id },
                    permissions: readGrant,
                });
                assert(
                    (
                        await f.reader.rag.indexing.search({
                            collectionId,
                            query: 'cheval',
                            strategy: 'LEXICAL',
                            topK: 1,
                            filters: {},
                        })
                    ).results.length > 0
                );
                const previous = await prisma.member.findUniqueOrThrow({
                    where: { id: f.readerMember },
                });
                const role = await prisma.organizationRole.create({
                    data: {
                        id: randomUUID(),
                        organizationId: f.org,
                        role: `search-reader-${randomUUID()}`,
                        permission: JSON.stringify({
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                            apiKey: ['create', 'read', 'update'],
                        }),
                    },
                });
                await prisma.member.update({
                    where: { id: f.readerMember },
                    data: { role: role.role },
                });
                try {
                    const key =
                        await f.reader.client.admin.organization.apiKeys.create(
                            {
                                name: 'Search-only source reader',
                                permissions: {
                                    ragCollection: ['read'],
                                    ragLibrary: ['read'],
                                },
                                collectionScopes: [
                                    {
                                        collectionId,
                                        read: true,
                                        manageDocuments: false,
                                    },
                                ],
                            }
                        );
                    const api = rpc(() => ({ 'x-api-key': key.key })).admin.rag
                        .indexing;
                    assert.equal(
                        (
                            await api.sourcePreview({
                                collectionId,
                                receipt: sourceReceipt,
                                offset: 0,
                            })
                        ).version,
                        1
                    );
                    const entered = Promise.withResolvers<void>();
                    const released = Promise.withResolvers<void>();
                    fixture.state.beforeEmbedding = async () => {
                        entered.resolve();
                        await released.promise;
                    };
                    const inFlight = api
                        .search({
                            collectionId,
                            query: 'cheval',
                            strategy: 'HYBRID',
                            topK: 1,
                            filters: {},
                        })
                        .then(
                            () => null,
                            (error: unknown) => error
                        );
                    const timer = setTimeout(
                        () =>
                            entered.reject(
                                new Error(
                                    'Embedding request did not reach the controlled provider.'
                                )
                            ),
                        5000
                    );
                    try {
                        await entered.promise;
                        await f.owner.rag.groups.removeMember({
                            id: group.id,
                            memberId: f.readerMember,
                        });
                    } finally {
                        clearTimeout(timer);
                        delete fixture.state.beforeEmbedding;
                        released.resolve();
                    }
                    const denied = await inFlight;
                    assert(
                        denied && typeof denied === 'object' && 'code' in denied
                    );
                    assert(
                        ['NOT_FOUND', 'FORBIDDEN'].includes(
                            String(denied.code)
                        ),
                        'Revocation during provider I/O must prevent result hydration and receipt issuance.'
                    );
                    await assert.rejects(
                        api.search({
                            collectionId,
                            query: 'cheval',
                            strategy: 'LEXICAL',
                            topK: 1,
                            filters: {},
                        })
                    );
                    await assert.rejects(
                        api.sourceOriginal({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    );
                    await assert.rejects(
                        f.reader.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                            offset: 0,
                        })
                    );
                    await f.owner.rag.groups.addMember({
                        id: group.id,
                        memberId: f.readerMember,
                    });
                    await prisma.organizationRole.update({
                        where: { id: role.id },
                        data: {
                            permission: JSON.stringify({ apiKey: ['read'] }),
                        },
                    });
                    await assert.rejects(
                        api.sourceOriginal({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    );
                    await assert.rejects(
                        api.search({
                            collectionId,
                            query: 'cheval',
                            strategy: 'LEXICAL',
                            topK: 1,
                            filters: {},
                        })
                    );
                } finally {
                    await prisma.member.update({
                        where: { id: f.readerMember },
                        data: { role: previous.role },
                    });
                }
            }
        );
        await t.test(
            'replacement retains exact v1 source receipts while publishing v2; detach denies both versions before cleanup',
            async () => {
                const replacement = await f.owner.rag.documents.replace({
                    id: french.id,
                    expectedVersionId: frenchVersionId,
                    requestId: randomUUID(),
                    file: new File(
                        [
                            'Les chevaux rentrent dans une écurie. shared exclusive version two.\n',
                        ],
                        'search-fr-v2.txt'
                    ),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (await f.owner.rag.documents.details({ id: french.id }))
                        .version?.version,
                    2
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                            offset: 0,
                        })
                    ).version,
                    1
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text(),
                    frenchText
                );
                await fixture.scan(6);
                const current = await search('cheval', 'LEXICAL');
                assert.equal(
                    current.results.find(
                        (item) => item.documentId === french.id
                    )?.version,
                    2
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                            offset: 0,
                        })
                    ).version,
                    1
                );
                await processDocumentCleanups(prisma);
                const old = await prisma.documentVersion.findUniqueOrThrow({
                    where: { id: frenchVersionId },
                });
                assert.equal(old.contentState, 'AVAILABLE');
                assert.equal(old.discardedAt, null);
                await f.owner.rag.documents.setCollection({
                    id: french.id,
                    collectionId,
                    attached: false,
                });
                assert.equal(
                    (await search('cheval', 'LEXICAL')).results.some(
                        (item) => item.documentId === french.id
                    ),
                    false
                );
                await assert.rejects(
                    f.owner.rag.indexing.sourcePreview({
                        collectionId,
                        receipt: sourceReceipt,
                        offset: 0,
                    })
                );
                await assert.rejects(
                    f.owner.rag.indexing.sourceOriginal({
                        collectionId,
                        receipt: sourceReceipt,
                    })
                );
                assert.notEqual(replacement.versionId, frenchVersionId);
            }
        );
        await t.test(
            'RPC and REST retrieval expose the same revision and executable OpenAPI operations',
            async () => {
                const rpcResult = await search('run', 'LEXICAL');
                const response = await app.request(
                    `/api/v1/admin/rag/collections/${collectionId}/search`,
                    {
                        method: 'POST',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            query: 'run',
                            strategy: 'LEXICAL',
                            topK: 20,
                            filters: {},
                        }),
                    }
                );
                assert.equal(
                    response.status,
                    200,
                    await response.clone().text()
                );
                const body = await response.json();
                assert.deepEqual(
                    body.results.map((item: { id: string }) => item.id),
                    rpcResult.results.map((item) => item.id)
                );
                const versions = await (
                    await app.request('/api-versions.json')
                ).json();
                const spec = await (await app.request('/spec/v1.json')).json();
                const alias = await (await app.request('/spec.json')).json();
                assert.deepEqual(alias, spec);
                assert.equal(
                    response.headers.get('Vectorix-API-Revision'),
                    spec.info.version.split('.')[1]
                );
                assert.equal(typeof spec.info.version, 'string');
                const [major, revision, patch] = String(spec.info.version)
                    .split('.')
                    .map(Number);
                assert.equal(patch, 0);
                assert.equal(versions.currentMajor, major);
                assert.equal(
                    response.headers.get('Vectorix-API-Version'),
                    String(major)
                );
                const release = (
                    versions.versions as {
                        major: number;
                        revision: number;
                        status: string;
                        rpcPath: string;
                        restPath: string;
                        specPath: string;
                    }[]
                ).find((entry) => entry.major === major);
                assert.deepEqual(release, {
                    major,
                    revision,
                    status: 'current',
                    rpcPath: `/rpc/v${major}`,
                    restPath: `/api/v${major}`,
                    specPath: `/spec/v${major}.json`,
                });
                for (const path of [
                    '/admin/rag/collections/{collectionId}/search',
                    '/admin/rag/collections/{collectionId}/sources/preview',
                    '/admin/rag/collections/{collectionId}/sources/original',
                ])
                    assert(spec.paths[path].post);
            }
        );
    } finally {
        await fixture.close();
    }
}
