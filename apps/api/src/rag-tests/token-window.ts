import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f, readGrant } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';

/** Real PostgreSQL/vector/S3 journeys; the local native-protocol fixture supplies explicitly synthetic vectors. */
export async function tokenWindowTests(t: TestContext) {
    const previous = { organization: f.org, owner: f.ownerMember };
    const organization = await f.owner.post('organization/create', {
        name: `Token windows ${randomUUID()}`,
        slug: `token-windows-${randomUUID()}`,
    });
    await f.owner.post('organization/set-active', {
        organizationId: organization.id,
    });
    f.org = organization.id;
    f.ownerMember = (await f.owner.client.admin.members.me({})).id;
    const reader = await prisma.member.create({
        data: {
            id: randomUUID(),
            organizationId: f.org,
            userId: f.users[2]!,
            role: 'member',
            createdAt: new Date(),
        },
    });
    await f.reader.post('organization/set-active', { organizationId: f.org });
    const fixture = await createIndexingFixture();
    const sizes = {
        targetTokens: 48,
        minTokens: 16,
        maxTokens: 64,
        overlapTokens: 8,
        semanticPercentile: 90,
        parentMaxTokens: 2048,
    };
    const profile = {
        provider: 'OLLAMA' as const,
        model: 'fixture:latest',
        dimensions: 3,
        chunkingStrategy: 'TOKEN_WINDOW' as const,
        chunking: sizes,
    };
    const collection = await f.owner.rag.collections.create({
        name: 'Token-window first index',
        profile,
        grantCreatorRead: true,
    });
    const text =
        '# Forêts\n' +
        'Les renards protègent la forêt. Café cafe\u0301 🌲. '.repeat(12) +
        '\n# Forests\n' +
        'Foxes protect the forest. Context is preserved across headings. '.repeat(
            12
        ) +
        '\nshort final tail';
    const document = await fixture.upload(
        text,
        'token-windows.md',
        collection.id
    );
    const requestId = randomUUID();
    let generationId = '';
    let receipt = '';
    const searchInput = {
        collectionId: collection.id,
        query: 'forest',
        strategy: 'HYBRID' as const,
        topK: 20,
        filters: {},
    };
    try {
        await t.test(
            'token windows publish exact Unicode text, immutable spans and estimated counts with idempotent accounting',
            async () => {
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId,
                });
                generationId = started.generationId;
                await fixture.scan(6);
                const generation =
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: generationId },
                    });
                assert.equal(generation.status, 'ACTIVE');
                assert.equal(generation.chunkerVersion, 'token-window-utf8-v1');
                const chunks = await f.owner.rag.indexing.chunks({
                    collectionId: collection.id,
                    documentId: document.id,
                    limit: 100,
                });
                assert(chunks.total > 2 && chunks.total < 100);
                assert.equal(chunks.items.length, chunks.total);
                const covered = new Set<number>();
                for (const [ordinal, chunk] of chunks.items.entries()) {
                    assert.equal(chunk.ordinal, ordinal);
                    assert.equal(chunk.version, 1);
                    assert.equal(chunk.tokenCountIsEstimate, true);
                    assert.equal(
                        chunk.tokenCount,
                        Math.ceil(Buffer.byteLength(chunk.text) / 3)
                    );
                    assert(
                        Buffer.byteLength(chunk.text) <= sizes.maxTokens * 3
                    );
                    assert.equal(chunk.sourceSpansTruncated, false);
                    assert(chunk.sourceSpans.length > 0);
                    const start = Math.min(
                        ...chunk.sourceSpans.map((span) => span.start)
                    );
                    const end = Math.max(
                        ...chunk.sourceSpans.map((span) => span.end)
                    );
                    assert.equal(chunk.text, text.slice(start, end));
                    assert(
                        !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk.text)
                    );
                    for (const span of chunk.sourceSpans) {
                        assert(
                            span.start >= span.source.start &&
                                span.end <= span.source.end
                        );
                        for (
                            let position = span.start;
                            position < span.end;
                            position++
                        )
                            covered.add(position);
                    }
                }
                for (let position = 0; position < text.length; position++) {
                    if (!/\s/u.test(text[position]!))
                        assert(covered.has(position));
                }
                assert(chunks.items.at(-1)!.text.endsWith('short final tail'));
                const before = await prisma.chunk.findMany({
                    where: { generationId },
                    orderBy: { ordinal: 'asc' },
                    select: {
                        id: true,
                        textHash: true,
                        embeddingInputHash: true,
                        ordinal: true,
                    },
                });
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(usage.activeChunks, BigInt(chunks.total));
                assert.equal(usage.reservedChunks, 0n);
                assert.deepEqual(
                    await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId,
                    }),
                    started
                );
                await fixture.scan(3);
                assert.deepEqual(
                    await prisma.chunk.findMany({
                        where: { generationId },
                        orderBy: { ordinal: 'asc' },
                        select: {
                            id: true,
                            textHash: true,
                            embeddingInputHash: true,
                            ordinal: true,
                        },
                    }),
                    before
                );
                const after =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(after.activeChunks, usage.activeChunks);
                assert.equal(after.retainedChunks, usage.retainedChunks);
                assert.equal(after.reservedChunks, usage.reservedChunks);
            }
        );

        await t.test(
            'token-window search, filters and source receipts enforce current collection and organization access',
            async () => {
                for (const strategy of [
                    'LEXICAL',
                    'VECTOR',
                    'HYBRID',
                ] as const) {
                    const result = await f.owner.rag.indexing.search({
                        ...searchInput,
                        strategy,
                    });
                    assert.equal(result.generationId, generationId);
                    assert(
                        result.results.some(
                            (row) => row.documentId === document.id
                        )
                    );
                    receipt = result.results[0]!.source.receipt;
                }
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    text
                );
                await assert.rejects(
                    f.reader.rag.indexing.chunks({
                        collectionId: collection.id,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: reader.id },
                    permissions: readGrant,
                });
                assert(
                    (await f.reader.rag.indexing.search(searchInput)).results
                        .length > 0
                );
                assert.equal(
                    await (
                        await f.reader.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    text
                );
                await assert.rejects(
                    f.reader.rag.indexing.rebuild({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        expectedActiveGenerationId: generationId,
                        requestId: randomUUID(),
                    })
                );
                await f.owner.rag.indexing.updateMetadata({
                    collectionId: collection.id,
                    documentId: document.id,
                    expectedMetadataRevision: 1,
                    language: 'MIXED',
                    tags: ['token-window'],
                    metadata: {},
                });
                await fixture.scan(5);
                const filtered = await f.owner.rag.indexing.search({
                    ...searchInput,
                    filters: {
                        languages: ['MIXED'],
                        tags: ['token-window'],
                        documentIds: [document.id],
                    },
                });
                assert(filtered.results.length > 0);
                assert(
                    filtered.results.every(
                        (row) =>
                            row.language === 'MIXED' &&
                            row.tags.includes('token-window')
                    )
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.search({
                            ...searchInput,
                            filters: { languages: ['FR'] },
                        })
                    ).results.length,
                    0
                );
                await f.owner.rag.collections.removeGrant({
                    id: collection.id,
                    target: { type: 'member', id: reader.id },
                });
                await assert.rejects(
                    f.reader.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );
            }
        );

        await t.test(
            'saved unknown and mismatched chunker versions reject before embedding, reservation or partial chunk writes',
            async () => {
                for (const invalid of [
                    'future-token-version',
                    'structure-utf8-v1',
                ]) {
                    const added = await fixture.upload(
                        'New canonical source for a saved-version rejection. '.repeat(
                            10
                        ),
                        `${invalid}.txt`,
                        collection.id
                    );
                    await prisma.indexGeneration.update({
                        where: { id: generationId },
                        data: { chunkerVersion: invalid },
                    });
                    const calls = fixture.state.embedCalls;
                    try {
                        await assert.rejects(
                            f.owner.rag.indexing.search({
                                ...searchInput,
                                strategy: 'LEXICAL',
                            }),
                            (error: unknown) => {
                                assert(
                                    error &&
                                        typeof error === 'object' &&
                                        'data' in error
                                );
                                assert.deepEqual(error.data, {
                                    errorCode: 'MODEL_CHANGED',
                                });
                                return true;
                            }
                        );
                        await fixture.scan(3);
                        const task = await prisma.indexTask.findFirstOrThrow({
                            where: {
                                generationId,
                                indexedDocument: {
                                    is: { documentId: added.id },
                                },
                                kind: 'INDEX_DOCUMENT',
                            },
                        });
                        assert.equal(task.status, 'FAILED');
                        assert.equal(task.errorCode, 'MODEL_CHANGED');
                        assert.equal(fixture.state.embedCalls, calls);
                        assert.equal(
                            await prisma.chunk.count({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId!,
                                },
                            }),
                            0
                        );
                        assert.equal(task.reservedChunks, 0);
                    } finally {
                        await prisma.indexGeneration.update({
                            where: { id: generationId },
                            data: { chunkerVersion: 'token-window-utf8-v1' },
                        });
                        await f.owner.rag.documents.setCollection({
                            id: added.id,
                            collectionId: collection.id,
                            attached: false,
                        });
                        await fixture.scan(4);
                    }
                }
            }
        );

        await t.test(
            'a mismatched saved version also blocks provisioning and recovers only after the exact pair is restored',
            async () => {
                const draft = await f.owner.rag.collections.create({
                    name: 'Token provisioning version fence',
                    profile,
                });
                await fixture.upload(
                    'Provisioning must honor the saved token-window version. '.repeat(
                        8
                    ),
                    'token-provision.txt',
                    draft.id
                );
                const accepted = await f.owner.rag.indexing.start({
                    collectionId: draft.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await prisma.indexGeneration.update({
                    where: { id: accepted.generationId },
                    data: { chunkerVersion: 'structure-utf8-v1' },
                });
                const calls = fixture.state.embedCalls;
                await fixture.scan(3);
                const task = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        generationId: accepted.generationId,
                        kind: 'PROVISION',
                    },
                });
                assert.equal(task.status, 'FAILED');
                assert.equal(task.errorCode, 'MODEL_CHANGED');
                assert.equal(fixture.state.embedCalls, calls);
                assert.equal(
                    await prisma.chunk.count({
                        where: { generationId: accepted.generationId },
                    }),
                    0
                );
                await prisma.indexGeneration.update({
                    where: { id: accepted.generationId },
                    data: { chunkerVersion: 'token-window-utf8-v1' },
                });
                await f.owner.rag.indexing.retry({
                    collectionId: draft.id,
                    taskId: task.id,
                });
                await fixture.scan(6);
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: draft.id,
                        })
                    ).active?.id,
                    accepted.generationId
                );
            }
        );

        await t.test(
            'token-window quota rejection leaves the active publication searchable without provider cost or partial accounting',
            async () => {
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                const quota = await prisma.organizationQuota.findUniqueOrThrow({
                    where: { organizationId: f.org },
                });
                const added = await fixture.upload(
                    'Quota rejection must not publish a partial window document. '.repeat(
                        20
                    ),
                    'token-quota.txt',
                    collection.id
                );
                await prisma.organizationQuota.update({
                    where: { organizationId: f.org },
                    data: { chunksPerCollection: Number(usage.activeChunks) },
                });
                try {
                    const calls = fixture.state.embedCalls;
                    await fixture.scan(4);
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId,
                            indexedDocument: { is: { documentId: added.id } },
                            kind: 'INDEX_DOCUMENT',
                        },
                    });
                    assert.equal(task.errorCode, 'QUOTA_EXCEEDED');
                    assert.equal(task.status, 'FAILED');
                    assert.equal(fixture.state.embedCalls, calls);
                    assert.equal(
                        await prisma.chunk.count({
                            where: {
                                indexedDocumentId: task.indexedDocumentId!,
                            },
                        }),
                        0
                    );
                    const current =
                        await prisma.collectionIndexAccounting.findUniqueOrThrow(
                            { where: { collectionId: collection.id } }
                        );
                    assert.equal(current.activeChunks, usage.activeChunks);
                    assert.equal(current.reservedChunks, 0n);
                    assert.equal(
                        (await f.owner.rag.indexing.search(searchInput))
                            .generationId,
                        generationId
                    );
                } finally {
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            chunksPerCollection: quota.chunksPerCollection,
                        },
                    });
                    await f.owner.rag.documents.setCollection({
                        id: added.id,
                        collectionId: collection.id,
                        attached: false,
                    });
                    await fixture.scan(4);
                }
            }
        );

        await t.test(
            'token-window replacement retains the old source and retries the new immutable version without changing chunk identities',
            async () => {
                const old = (
                    await f.owner.rag.documents.details({ id: document.id })
                ).version!;
                const replacement =
                    'Replacement context: forests shelter wildlife. La forêt protège les renards. 🌳 '.repeat(
                        18
                    );
                await f.owner.rag.documents.replace({
                    id: document.id,
                    expectedVersionId: old.id,
                    requestId: randomUUID(),
                    file: new File([replacement], 'token-windows-v2.md'),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                const version = (
                    await f.owner.rag.documents.details({ id: document.id })
                ).version!;
                fixture.state.rejectEmbeddings = true;
                try {
                    await fixture.scan(3);
                    const candidate =
                        await prisma.indexedDocument.findFirstOrThrow({
                            where: {
                                generationId,
                                documentId: document.id,
                                sourceVersionId: version.id,
                            },
                        });
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            indexedDocumentId: candidate.id,
                            kind: 'INDEX_DOCUMENT',
                        },
                    });
                    assert.equal(task.errorCode, 'PROVIDER_REJECTED');
                    const chunks = await prisma.chunk.findMany({
                        where: { indexedDocumentId: candidate.id },
                        orderBy: { ordinal: 'asc' },
                        select: {
                            id: true,
                            ordinal: true,
                            textHash: true,
                            sourceSpans: true,
                        },
                    });
                    assert(chunks.length > 2);
                    const oldSearch = await f.owner.rag.indexing.search({
                        ...searchInput,
                        strategy: 'LEXICAL',
                    });
                    assert(oldSearch.results.length > 0);
                    assert(oldSearch.results.every((row) => row.version === 1));
                    fixture.state.rejectEmbeddings = false;
                    await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { availableAt: new Date(0) },
                    });
                    await fixture.scan(6);
                    const current = await f.owner.rag.indexing.chunks({
                        collectionId: collection.id,
                        documentId: document.id,
                        limit: 100,
                    });
                    assert.equal(current.total, chunks.length);
                    assert(current.items.every((row) => row.version === 2));
                    assert.deepEqual(
                        await prisma.chunk.findMany({
                            where: { indexedDocumentId: candidate.id },
                            orderBy: { ordinal: 'asc' },
                            select: {
                                id: true,
                                ordinal: true,
                                textHash: true,
                                sourceSpans: true,
                            },
                        }),
                        chunks
                    );
                    assert.equal(
                        await (
                            await f.owner.rag.indexing.sourceOriginal({
                                collectionId: collection.id,
                                receipt,
                            })
                        ).text(),
                        text
                    );
                } finally {
                    fixture.state.rejectEmbeddings = false;
                }
            }
        );

        await t.test(
            'structure generations replay their saved version while a token-window rebuild retries deterministic chunks and retains old citations',
            async () => {
                const legacy = await fixture.collection(
                    'Structure to token windows'
                );
                const source = await fixture.upload(
                    text,
                    'structure-to-tokens.md',
                    legacy.id
                );
                const started = await f.owner.rag.indexing.start({
                    collectionId: legacy.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await fixture.scan(6);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        })
                    ).chunkerVersion,
                    'structure-utf8-v1'
                );
                const query = { ...searchInput, collectionId: legacy.id };
                const captured = await f.owner.rag.indexing.search(query);
                const oldReceipt = captured.results[0]!.source.receipt;
                const changed = await f.owner.rag.collections.update({
                    id: legacy.id,
                    expectedRevision: 1,
                    name: legacy.name,
                    description: legacy.description,
                    profile: {
                        ...collectionProfile
                            .strip()
                            .parse(legacy.configuration),
                        ...profile,
                    },
                });
                assert.equal(
                    (await f.owner.rag.indexing.search(query)).generationId,
                    started.generationId
                );
                const candidate = await f.owner.rag.indexing.rebuild({
                    collectionId: legacy.id,
                    expectedRevision: changed.configurationRevision,
                    expectedActiveGenerationId: started.generationId,
                    requestId: randomUUID(),
                });
                fixture.state.rejectEmbeddings = true;
                try {
                    await fixture.scan(3);
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: candidate.generationId,
                            kind: 'INDEX_DOCUMENT',
                            indexedDocument: { is: { documentId: source.id } },
                        },
                    });
                    assert.equal(task.errorCode, 'PROVIDER_REJECTED');
                    const before = await prisma.chunk.findMany({
                        where: { generationId: candidate.generationId },
                        orderBy: { ordinal: 'asc' },
                        select: {
                            id: true,
                            ordinal: true,
                            textHash: true,
                            embeddingInputHash: true,
                            sourceSpans: true,
                        },
                    });
                    assert(before.length > 2);
                    const oldSearch = await f.owner.rag.indexing.search({
                        ...query,
                        strategy: 'LEXICAL',
                    });
                    assert.equal(oldSearch.generationId, started.generationId);
                    fixture.state.rejectEmbeddings = false;
                    await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { availableAt: new Date(0) },
                    });
                    await fixture.scan(6);
                    assert.equal(
                        (await f.owner.rag.indexing.search(query)).generationId,
                        candidate.generationId
                    );
                    assert.deepEqual(
                        await prisma.chunk.findMany({
                            where: { generationId: candidate.generationId },
                            orderBy: { ordinal: 'asc' },
                            select: {
                                id: true,
                                ordinal: true,
                                textHash: true,
                                embeddingInputHash: true,
                                sourceSpans: true,
                            },
                        }),
                        before
                    );
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: candidate.generationId },
                            })
                        ).chunkerVersion,
                        'token-window-utf8-v1'
                    );
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: started.generationId },
                            })
                        ).status,
                        'RETIRED'
                    );
                    assert.equal(
                        await (
                            await f.owner.rag.indexing.sourceOriginal({
                                collectionId: legacy.id,
                                receipt: oldReceipt,
                            })
                        ).text(),
                        text
                    );
                    const usage =
                        await prisma.collectionIndexAccounting.findUniqueOrThrow(
                            { where: { collectionId: legacy.id } }
                        );
                    assert.equal(usage.activeChunks, BigInt(before.length));
                    assert.equal(usage.reservedChunks, 0n);
                    assert(usage.retainedChunks > 0n);
                } finally {
                    fixture.state.rejectEmbeddings = false;
                }
            }
        );

        await t.test(
            'parent-child drafts remain explicitly unsupported before provider probing',
            async () => {
                for (const unsupported of [
                    { parentChild: true },
                ]) {
                    const draft = await f.owner.rag.collections.create({
                        name: 'Future chunking remains gated',
                        profile: { ...profile, ...unsupported },
                    });
                    const calls = fixture.state.embedCalls;
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: draft.id,
                            })
                        ).unsupportedReason,
                        'PROFILE_UNSUPPORTED'
                    );
                    await assert.rejects(
                        f.owner.rag.indexing.start({
                            collectionId: draft.id,
                            expectedRevision: 1,
                            requestId: randomUUID(),
                        }),
                        (error: unknown) => {
                            assert(
                                error &&
                                    typeof error === 'object' &&
                                    'data' in error
                            );
                            assert.deepEqual(error.data, {
                                errorCode: 'PROFILE_UNSUPPORTED',
                            });
                            return true;
                        }
                    );
                    assert.equal(fixture.state.embedCalls, calls);
                    assert.equal(
                        await prisma.indexGeneration.count({
                            where: { collectionId: draft.id },
                        }),
                        0
                    );
                }
            }
        );
    } finally {
        await fixture.close();
        f.org = previous.organization;
        f.ownerMember = previous.owner;
        await f.owner.post('organization/set-active', {
            organizationId: f.org,
        });
        await f.reader.post('organization/set-active', {
            organizationId: f.org,
        });
    }
}
