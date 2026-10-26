import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { VectorixApiV1Client, VectorixApiV1Outputs } from '@repo/api';
import { prisma } from '@repo/db';
import { fixture as f, readGrant, rpc } from './fixtures';
import { createParentFixture, scanParent } from './parent-fixtures';
import { semanticLatch } from './semantic-fixtures';
import { createRerankingHttpFixture } from './reranking-http-fixture';

type RagApi = VectorixApiV1Client['admin']['rag'];
type SearchRequest = Parameters<RagApi['reranking']['search']>[0];
type SearchResult =
    VectorixApiV1Outputs['admin']['rag']['indexing']['search']['results'][number];

function failure(expected: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: expected });
        assert(
            !JSON.stringify(error).includes('PRIVATE_RERANK_PROVIDER_SENTINEL')
        );
        assert(!JSON.stringify(error).includes('fixture-rerank-key'));
        return true;
    };
}

/** Real catalog/search/authorization and local native HTTP; deterministic fixture scores are not hosted relevance evidence. */
export async function rerankingSearchTests(t: TestContext) {
    const fixture = await createParentFixture('Optional reranked search', true);
    const native = await createRerankingHttpFixture();
    const memberId = f.readerMember;
    let previousRole: string | undefined;
    let roleId: string | undefined;
    let scopedApi: RagApi | undefined;
    let oldApi: RagApi | undefined;
    const readerPermissions = {
        ragCollection: ['read'],
        ragLibrary: ['read'],
        ragRerank: ['use'],
        apiKey: ['create', 'read', 'update'],
    };
    try {
        for (const provider of ['COHERE', 'VOYAGE'] as const)
            await f.owner.rag.credentials.create({
                name: `Native ${provider} reranking`,
                data: {
                    provider,
                    endpoint: native.endpoint,
                    apiKey: 'fixture-rerank-key',
                },
                activate: true,
            });
        const collection = await fixture.collection();
        const collectionId = collection.id;
        const ordinaryText = Array.from(
            { length: 12 },
            (_, index) =>
                `Shared baseline forest passage ${index} protects the river and its familiar garden.`
        ).join(' ');
        const targetText = Array.from(
            { length: 12 },
            (_, index) =>
                `Shared reranktarget solar reranktarget warranty reranktarget replacement reranktarget policy passage ${index} reranktarget.`
        ).join(' ');
        const first = await fixture.upload(
            ordinaryText,
            'rerank-baseline.txt',
            collectionId
        );
        const target = await fixture.upload(
            targetText,
            'rerank-target.txt',
            collectionId
        );
        const single = await fixture.upload(
            'Shared solitary source with one child and its exact receipt.',
            'rerank-single.txt',
            collectionId
        );
        await f.owner.rag.indexing.updateMetadata({
            collectionId,
            documentId: target.id,
            expectedMetadataRevision: 1,
            language: 'EN',
            tags: ['rerank-target'],
            metadata: {},
        });
        fixture.state.vectorForText = (text) => {
            if (text.includes('reranktarget')) return [0, 1, 0];
            return text.includes('solitary') ? [1, 1, 0] : [1, 0, 0];
        };
        const started = await f.owner.rag.indexing.start({
            collectionId,
            expectedRevision: collection.configurationRevision,
            requestId: randomUUID(),
        });
        // The complete catalog retains many active generations. Activation
        // fairly rotates only ten per scan, so await this owned publication
        // instead of assuming six global scans always reach its cursor slot.
        for (let pass = 0; pass < 50; pass++) {
            await scanParent(fixture, started.generationId, 1);
            const failed = await prisma.indexTask.findMany({
                where: {
                    organizationId: f.org,
                    generationId: started.generationId,
                    status: 'FAILED',
                },
                select: { kind: true, stage: true, errorCode: true },
                take: 10,
            });
            assert.deepEqual(
                failed,
                [],
                'The owned reranking generation must publish without terminal worker failures.'
            );
            if (
                (await f.owner.rag.indexing.status({ collectionId })).active
                    ?.id === started.generationId
            )
                break;
        }
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId })).active?.id,
            started.generationId
        );
        const children = await prisma.chunk.findMany({
            where: {
                organizationId: f.org,
                generationId: started.generationId,
                kind: 'CHILD',
            },
            select: {
                id: true,
                text: true,
                parentId: true,
                indexedDocument: { select: { documentId: true } },
            },
            take: 51,
        });
        assert(children.length > 3 && children.length <= 50);
        assert(children.every((child) => child.parentId));
        assert.equal(
            children.filter(
                (child) => child.indexedDocument.documentId === single.id
            ).length,
            1
        );
        const childTexts = new Set(children.map((child) => child.text));
        const parents = await prisma.chunk.findMany({
            where: {
                organizationId: f.org,
                generationId: started.generationId,
                kind: 'PARENT',
            },
            select: { text: true },
            take: 50,
        });
        assert(parents.some((parent) => !childTexts.has(parent.text)));
        const targetTexts = new Set(
            children
                .filter(
                    (child) => child.indexedDocument.documentId === target.id
                )
                .map((child) => child.text)
        );
        let revision = 0;
        const input = (extra: Partial<SearchRequest> = {}): SearchRequest => ({
            collectionId,
            query: 'Shared question',
            strategy: 'VECTOR',
            topK: 10,
            filters: {},
            requestId: randomUUID(),
            expectedRerankRevision: Math.max(1, revision),
            compare: true,
            ...extra,
        });
        const configure = async (
            provider: 'COHERE' | 'VOYAGE',
            enabled = true,
            candidatePool = 50
        ) => {
            const result = await f.owner.rag.reranking.configure({
                collectionId,
                expectedRevision: revision,
                enabled,
                provider,
                model:
                    provider === 'COHERE'
                        ? 'rerank-v5.0-fast'
                        : 'rerank-3-lite',
                candidatePool,
            });
            revision = result.revision;
            return result;
        };
        const ordinary = () =>
            f.owner.rag.indexing.search({
                collectionId,
                query: 'Shared question',
                strategy: 'VECTOR',
                topK: 10,
                filters: {},
            });

        await t.test(
            'reranking is explicitly off by default and ordinary search keeps its contract',
            async () => {
                const profile = await f.owner.rag.reranking.profile({
                    collectionId,
                });
                assert.equal(profile.revision, 0);
                assert.equal(profile.enabled, false);
                assert.equal(profile.configuration, null);
                assert.equal(profile.canUse, false);
                assert.equal(profile.canManage, true);
                const beforeEmbedding = fixture.state.embedCalls;
                await assert.rejects(
                    f.owner.rag.reranking.search(input()),
                    failure('RERANK_DISABLED')
                );
                assert.equal(fixture.state.embedCalls, beforeEmbedding);
                const result = await ordinary();
                assert(result.results.length > 0);
                assert.equal(result.results[0]?.documentId, first.id);
                assert.equal('reranking' in result, false);
                assert(result.results.every((row) => !('rerankScore' in row)));
                assert.equal(native.state.calls.length, 0);
            }
        );

        await t.test(
            'configuration uses CAS without rebuilding embeddings and a small pool never expands to topK',
            async () => {
                const configured = await configure('COHERE', true, 1);
                assert.equal(configured.revision, 1);
                assert.equal(configured.canUse, true);
                assert.equal(
                    configured.configuration?.bindingSource,
                    'ORGANIZATION'
                );
                await assert.rejects(
                    f.owner.rag.reranking.configure({
                        collectionId,
                        expectedRevision: 0,
                        enabled: true,
                        provider: 'COHERE',
                        model: 'rerank-v5.0-fast',
                        candidatePool: 50,
                    }),
                    failure('RERANK_PROFILE_CHANGED')
                );
                const result = await f.owner.rag.reranking.search(
                    input({ topK: 2 })
                );
                assert.equal(result.reranking.candidateLimit, 1);
                assert.equal(result.reranking.candidateCount, 1);
                assert.equal(result.results.length, 1);
                assert.equal(result.reranking.underfilled, true);
                assert.equal(native.state.calls.at(-1)?.documents.length, 1);
                await configure('COHERE');
                assert.equal(
                    (await f.owner.rag.indexing.status({ collectionId })).active
                        ?.id,
                    started.generationId
                );
                const before = native.state.calls.length;
                await ordinary();
                assert.equal(native.state.calls.length, before);
            }
        );

        await t.test(
            'native scores reorder the same child pool while parent deduplication and exact source receipts remain intact',
            async () => {
                const baseline = await ordinary();
                const beforeEmbedding = fixture.state.embedCalls;
                const result = await f.owner.rag.reranking.search(input());
                assert.equal(
                    fixture.state.embedCalls,
                    beforeEmbedding + 1,
                    'Comparison must not retrieve or embed a second time.'
                );
                assert.equal(result.generationId, started.generationId);
                assert.equal(result.reranking.provider, 'COHERE');
                assert.equal(result.reranking.model, 'rerank-v5.0-fast');
                assert.equal(result.reranking.candidateCount, children.length);
                assert.equal(result.reranking.rerankedCount, children.length);
                assert.equal(result.reranking.usage.providerInputTokens, 13);
                assert.equal(result.reranking.usage.billedInputTokens, null);
                assert.equal(result.reranking.usage.billedSearchUnits, 1);
                assert.equal(result.results[0]?.documentId, target.id);
                assert(result.results[0]!.rerankScore > 0.9);
                assert(result.comparison);
                assert.deepEqual(
                    result.comparison.results.map((row) => row.id),
                    baseline.results.map((row) => row.id)
                );
                assert.notDeepEqual(
                    result.results.map((row) => row.id),
                    result.comparison.results.map((row) => row.id)
                );
                const captured = native.state.calls.at(-1)!;
                assert.equal(captured.documents.length, children.length);
                assert(
                    captured.documents.every((text) => childTexts.has(text)),
                    'Only canonical child text may be sent, never derived parent context.'
                );
                for (const order of [
                    result.results,
                    result.comparison.results,
                ]) {
                    assert.equal(
                        new Set(order.map((row) => row.parentContext?.id)).size,
                        order.length
                    );
                    assert(
                        order.every(
                            (row) =>
                                row.sourceSpans.length <= 64 &&
                                row.parentContext &&
                                row.parentContext.sourceSpans.length <= 64
                        )
                    );
                }
                const shared = result.results.filter((row) =>
                    result.comparison!.results.some(
                        (other) => other.id === row.id
                    )
                );
                assert(shared.length > 0);
                for (const row of shared) {
                    const comparison: SearchResult =
                        result.comparison.results.find(
                            (other) => other.id === row.id
                        )!;
                    assert.deepEqual(row.scores, comparison.scores);
                    assert.deepEqual(row.source, comparison.source);
                }
                const best = result.results[0]!;
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: best.source.receipt,
                            offset: 0,
                        })
                    ).text,
                    targetText
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId,
                            receipt: best.source.receipt,
                        })
                    ).text(),
                    targetText
                );
            }
        );

        await t.test(
            'filters apply before the native pool; empty and invalid inputs never dispatch',
            async () => {
                const filtered = await f.owner.rag.reranking.search(
                    input({
                        filters: {
                            documentIds: [target.id],
                            languages: ['EN'],
                            tags: ['rerank-target'],
                        },
                    })
                );
                assert(
                    filtered.results.every(
                        (row) => row.documentId === target.id
                    )
                );
                assert(filtered.results.length > 0);
                assert(
                    native.state.calls
                        .at(-1)!
                        .documents.every((text) => targetTexts.has(text))
                );
                const before = native.state.calls.length;
                const empty = await f.owner.rag.reranking.search(
                    input({ filters: { tags: ['absent-rerank-tag'] } })
                );
                assert.deepEqual(empty.results, []);
                assert.equal(empty.reranking.candidateCount, 0);
                assert.equal(empty.reranking.rerankedCount, 0);
                assert.deepEqual(empty.reranking.usage, {
                    providerInputTokens: null,
                    billedInputTokens: null,
                    billedSearchUnits: null,
                });
                assert.equal(
                    (
                        await prisma.rerankRequest.findUniqueOrThrow({
                            where: { id: empty.reranking.attemptId },
                        })
                    ).state,
                    'SKIPPED'
                );
                await assert.rejects(
                    f.owner.rag.reranking.search(
                        input({
                            filters: {
                                metadata: [
                                    {
                                        field: 'undeclared_field',
                                        operator: 'EQ',
                                        value: 'x',
                                    },
                                ],
                            },
                        })
                    ),
                    failure('RERANK_INPUT_INVALID')
                );
                await assert.rejects(
                    f.owner.rag.reranking.search(
                        input({
                            filters: {
                                metadata: [
                                    {
                                        field: 'invalid-field',
                                        operator: 'EQ',
                                        value: 'x',
                                    },
                                ],
                            },
                        })
                    ),
                    { code: 'BAD_REQUEST' }
                );
                const beforeEmbedding = fixture.state.embedCalls;
                await assert.rejects(
                    f.owner.rag.reranking.search(
                        input({ query: 'é'.repeat(2100) })
                    ),
                    failure('INPUT_TOO_LARGE')
                );
                assert.equal(fixture.state.embedCalls, beforeEmbedding);
                assert.equal(native.state.calls.length, before);
            }
        );

        await t.test(
            'explicit new key permission, issuer rights and collection scope are required; old read keys keep ordinary search only',
            async () => {
                const member = await prisma.member.findUniqueOrThrow({
                    where: { id: memberId },
                });
                previousRole = member.role;
                const role = await prisma.organizationRole.create({
                    data: {
                        id: randomUUID(),
                        organizationId: f.org,
                        role: `rerank-reader-${randomUUID()}`,
                        permission: JSON.stringify(readerPermissions),
                    },
                });
                roleId = role.id;
                await prisma.member.update({
                    where: { id: memberId },
                    data: { role: role.role },
                });
                await f.owner.rag.collections.setGrant({
                    id: collectionId,
                    target: { type: 'member', id: memberId },
                    permissions: readGrant,
                });
                const scopes = [
                    { collectionId, read: true, manageDocuments: false },
                ];
                const old =
                    await f.reader.client.admin.organization.apiKeys.create({
                        name: 'Existing ordinary search key',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                        },
                        collectionScopes: scopes,
                    });
                oldApi = rpc(() => ({ 'x-api-key': old.key })).admin.rag;
                const key =
                    await f.reader.client.admin.organization.apiKeys.create({
                        name: 'Explicit reranking search key',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                            ragRerank: ['use'],
                        },
                        collectionScopes: scopes,
                    });
                scopedApi = rpc(() => ({ 'x-api-key': key.key })).admin.rag;
                const before = native.state.calls.length;
                await assert.rejects(oldApi.reranking.search(input()));
                assert(
                    (
                        await oldApi.indexing.search({
                            collectionId,
                            query: 'Shared question',
                            strategy: 'VECTOR',
                            topK: 1,
                            filters: {},
                        })
                    ).results.length > 0
                );
                await assert.rejects(f.other.rag.reranking.search(input()));
                await assert.rejects(f.manager.rag.reranking.search(input()));
                const unscoped = await fixture.collection(
                    'Unscoped reranking collection'
                );
                await assert.rejects(
                    scopedApi.reranking.search(
                        input({ collectionId: unscoped.id })
                    )
                );
                await assert.rejects(
                    scopedApi.reranking.configure({
                        collectionId,
                        expectedRevision: revision,
                        enabled: false,
                        provider: 'COHERE',
                        model: 'rerank-v5.0-fast',
                        candidatePool: 50,
                    })
                );
                assert.equal(native.state.calls.length, before);
                assert(
                    (await scopedApi.reranking.search(input())).results.length >
                        0
                );
            }
        );

        await t.test(
            'Voyage uses its native saved profile and distinguishes unknown billing from known provider tokens',
            async () => {
                await configure('VOYAGE');
                const result = await f.owner.rag.reranking.search(
                    input({ compare: false })
                );
                assert.equal(result.comparison, undefined);
                assert.equal(result.reranking.provider, 'VOYAGE');
                assert.equal(native.state.calls.at(-1)?.model, 'rerank-3-lite');
                assert.deepEqual(result.reranking.usage, {
                    providerInputTokens: 17,
                    billedInputTokens: null,
                    billedSearchUnits: null,
                });
                assert.equal(result.results[0]?.documentId, target.id);
                await configure('COHERE');
            }
        );

        await t.test(
            'a native failure returns a sanitized refusal without fallback or repeated dispatch',
            async () => {
                native.state.reject = true;
                const request = input();
                const before = native.state.calls.length;
                try {
                    await assert.rejects(
                        f.owner.rag.reranking.search(request),
                        failure('PROVIDER_UNAVAILABLE')
                    );
                    assert.equal(native.state.calls.length, before + 1);
                    const row = await prisma.rerankRequest.findFirstOrThrow({
                        where: {
                            organizationId: f.org,
                            requestId: request.requestId,
                        },
                    });
                    assert.equal(row.state, 'FAILED');
                    assert.equal(row.providerInputTokens, null);
                    assert(row.dispatchedAt && row.capacityReleasedAt);
                    await assert.rejects(
                        f.owner.rag.reranking.search(request),
                        failure('RERANK_REQUEST_REPLAY')
                    );
                    assert.equal(native.state.calls.length, before + 1);
                } finally {
                    native.state.reject = false;
                }
            }
        );

        await t.test(
            'disabling during the native POST denies results only after validated usage settles',
            async () => {
                const latch = semanticLatch();
                native.state.beforeReply = latch.block;
                const request = input();
                const inFlight = f.owner.rag.reranking.search(request).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await latch.arrived();
                    await configure('COHERE', false);
                } finally {
                    delete native.state.beforeReply;
                    latch.release();
                }
                assert(failure('RERANK_DISABLED')(await inFlight));
                const row = await prisma.rerankRequest.findFirstOrThrow({
                    where: {
                        organizationId: f.org,
                        requestId: request.requestId,
                    },
                });
                assert.equal(row.state, 'VALIDATED');
                assert.equal(row.providerInputTokens, 13n);
                assert.equal(row.billedSearchUnits, 1);
                assert(row.capacityReleasedAt);
                const before = native.state.calls.length;
                await assert.rejects(
                    f.owner.rag.reranking.search(input()),
                    failure('RERANK_DISABLED')
                );
                assert.equal(native.state.calls.length, before);
                await configure('COHERE');
            }
        );

        await t.test(
            'revoking the key issuer rerank grant during POST settles known usage before denying content',
            async () => {
                assert(scopedApi && roleId);
                const latch = semanticLatch();
                native.state.beforeReply = latch.block;
                const request = input();
                const inFlight = scopedApi.reranking.search(request).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await latch.arrived();
                    await prisma.organizationRole.update({
                        where: { id: roleId },
                        data: {
                            permission: JSON.stringify({
                                ...readerPermissions,
                                ragRerank: [],
                            }),
                        },
                    });
                } finally {
                    delete native.state.beforeReply;
                    latch.release();
                }
                try {
                    assert(failure('ACCESS_REVOKED')(await inFlight));
                    const row = await prisma.rerankRequest.findFirstOrThrow({
                        where: {
                            organizationId: f.org,
                            requestId: request.requestId,
                        },
                    });
                    assert.equal(row.state, 'VALIDATED');
                    assert.equal(row.providerInputTokens, 13n);
                    assert.equal(row.billedSearchUnits, 1);
                    const before = native.state.calls.length;
                    await assert.rejects(scopedApi.reranking.search(input()));
                    assert(
                        (
                            await scopedApi.indexing.search({
                                collectionId,
                                query: 'Shared question',
                                strategy: 'VECTOR',
                                topK: 1,
                                filters: {},
                            })
                        ).results.length > 0,
                        'The issuer retained ordinary content reading; only reranking use was revoked.'
                    );
                    assert.equal(native.state.calls.length, before);
                } finally {
                    await prisma.organizationRole.update({
                        where: { id: roleId },
                        data: { permission: JSON.stringify(readerPermissions) },
                    });
                }
            }
        );
    } finally {
        if (previousRole !== undefined)
            await prisma.member.update({
                where: { id: memberId },
                data: { role: previousRole },
            });
        try {
            await native.close();
        } finally {
            await fixture.close();
        }
    }
}
