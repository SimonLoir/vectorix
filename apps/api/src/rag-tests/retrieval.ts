import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { parseRichDocument } from '../../../workers/src/extraction/main';
import { paragraphDocument } from './parent-provenance';
import { app } from '../app';
import { fixture as f, readGrant, rpc } from './fixtures';
import {
    createParentFixture,
    parentProfile,
    scanParent,
} from './parent-fixtures';

/** Sign intentionally expired, otherwise exact fixture receipts without changing the production clock. */
function expiredReceipt(receipt: string) {
    const payload = JSON.parse(
        Buffer.from(receipt.split('.')[0]!, 'base64url').toString()
    );
    const ttl = payload.expiresAt - payload.issuedAt;
    payload.expiresAt = Date.now() - 1;
    payload.issuedAt = payload.expiresAt - ttl;
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const key = createHmac('sha256', process.env.ENCRYPTION_SECRET!)
        .update('vectorix-index-source-receipt-v1')
        .digest();
    return (
        body + '.' + createHmac('sha256', key).update(body).digest('base64url')
    );
}

/** Wait for an owned HTTP request at a real PostgreSQL lock barrier, not an assumed scheduling delay. */
async function waitForChunkRead(pool: Pool, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const waiting = await pool.query(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%Chunk%' LIMIT 1",
            [blocker]
        );
        if (waiting.rowCount) return;
        await delay(10);
    }
    assert.fail('The owned retrieval request did not reach its Chunk read.');
}

/** Real HTTP, authorization, retained publications and PostgreSQL context; embeddings use a controlled native fixture. */
export async function retrievalTests(t: TestContext) {
    const fixture = await createParentFixture('External retrieval', true);
    try {
        const collection = await fixture.collection(
            'Chatbot context',
            'TOKEN_WINDOW',
            64
        );
        const collectionId = collection.id;
        const text = Array.from(
            { length: 180 },
            (_, index) => `forest${String(index).padStart(3, '0')} `
        ).join('');
        const document = await fixture.upload(
            text,
            'chatbot-context.txt',
            collectionId
        );
        await fixture.upload(
            'Unrelated solar context from a different document.',
            'other-context.txt',
            collectionId
        );
        const started = await f.owner.rag.indexing.start({
            collectionId,
            expectedRevision: 1,
            requestId: randomUUID(),
        });
        await scanParent(fixture, started.generationId, 8);
        const api = f.owner.client.retrieval;
        const searchInput = {
            collectionId,
            query: 'forest',
            strategy: 'VECTOR' as const,
            topK: 10,
            filters: { documentIds: [document.id] },
        };
        const result = await api.search(searchInput);
        assert(result.results.length > 0);
        const hit = result.results[Math.floor(result.results.length / 2)]!;
        const sourceInput = { collectionId, receipt: hit.source.receipt };
        const publication = await prisma.indexedDocument.findUniqueOrThrow({
            where: { id: hit.publicationId },
        });
        const children = await prisma.chunk.findMany({
            where: { indexedDocumentId: publication.id, kind: 'CHILD' },
            orderBy: { ordinal: 'asc' },
        });
        assert(children.length > 5);
        let keyId = '';
        let keyValue = '';
        await t.test(
            'retrieval search shares filters, child identity, parent context and exact-version sources over RPC and REST',
            async () => {
                assert.equal(result.generationId, started.generationId);
                assert(
                    result.results.every(
                        (row) =>
                            row.documentId === document.id && row.parentContext
                    )
                );
                const response = await app.request(
                    `/api/v1/retrieval/collections/${collectionId}/search`,
                    {
                        method: 'POST',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            query: searchInput.query,
                            strategy: searchInput.strategy,
                            topK: 10,
                            filters: searchInput.filters,
                        }),
                    }
                );
                assert.equal(response.status, 200);
                assert.equal(
                    response.headers.get('Vectorix-API-Revision'),
                    '24'
                );
                const rest = await response.json();
                assert.deepEqual(
                    rest.results.map((row: { id: string }) => row.id),
                    result.results.map((row) => row.id)
                );
                assert.equal(rest.generationId, result.generationId);
                const spec = await (await app.request('/spec/v1.json')).json();
                for (const suffix of ['search', 'context', 'citations/resolve'])
                    assert(
                        spec.paths[
                            `/retrieval/collections/{collectionId}/${suffix}`
                        ]?.post
                    );
                assert.deepEqual(
                    await (await app.request('/spec.json')).json(),
                    spec
                );
            }
        );
        await t.test(
            'citations resolve exact immutable provenance without leaking storage bindings',
            async () => {
                const citation = await api.citation(sourceInput);
                assert.equal(citation.chunkId, hit.id);
                assert.equal(citation.documentId, document.id);
                assert.equal(citation.publicationId, hit.publicationId);
                assert.equal(citation.generationId, hit.generationId);
                assert.equal(citation.version, 1);
                assert.equal(citation.documentName, 'chatbot-context.txt');
                assert.deepEqual(citation.sourceSpans, hit.sourceSpans);
                assert.equal(citation.source.receipt, hit.source.receipt);
                assert.equal(
                    citation.source.expiresAt.getTime(),
                    hit.source.expiresAt.getTime()
                );
                assert(
                    !JSON.stringify(citation).includes(publication.extractionId)
                );
            }
        );
        await t.test(
            'context contains bounded ordered same-publication children, never parent rows or other documents',
            async () => {
                const context = await api.context({
                    ...sourceInput,
                    before: 2,
                    after: 2,
                });
                const anchorIndex = children.findIndex(
                    (row) => row.id === hit.id
                );
                const expected = children.slice(
                    Math.max(0, anchorIndex - 2),
                    anchorIndex + 3
                );
                assert.equal(context.anchorChunkId, hit.id);
                assert.equal(context.generationId, hit.generationId);
                assert.equal(context.documentId, document.id);
                assert.deepEqual(
                    context.passages.map((row) => row.chunkId),
                    expected.map((row) => row.id)
                );
                assert(context.passages.length <= 5);
                assert(
                    context.passages.reduce(
                        (sum, row) => sum + row.text.length,
                        0
                    ) <= 245_760
                );
                for (const passage of context.passages) {
                    const child = children.find(
                        (row) => row.id === passage.chunkId
                    )!;
                    assert.equal(passage.text, child.text);
                    assert.equal(passage.publicationId, publication.id);
                    assert.equal(
                        passage.relation,
                        child.ordinal < hit.ordinal
                            ? 'BEFORE'
                            : child.ordinal > hit.ordinal
                              ? 'AFTER'
                              : 'MATCH'
                    );
                    assert(passage.sourceSpans.length <= 64);
                    assert.equal(
                        passage.source.expiresAt.getTime(),
                        hit.source.expiresAt.getTime()
                    );
                    const citation = await api.citation({
                        collectionId,
                        receipt: passage.source.receipt,
                    });
                    assert.equal(citation.chunkId, passage.chunkId);
                    assert.deepEqual(citation.sourceSpans, passage.sourceSpans);
                }
                const matchOnly = await api.context({
                    ...sourceInput,
                    before: 0,
                    after: 0,
                });
                assert.equal(matchOnly.passages.length, 1);
                assert.equal(matchOnly.passages[0]!.chunkId, hit.id);
                assert.equal(
                    matchOnly.passages[0]!.source.receipt,
                    hit.source.receipt
                );
            }
        );
        await t.test(
            'read-only scoped keys can search, cite and expand without write or reranking grants',
            async () => {
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Retrieval read-only fixture',
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
                    });
                keyId = key.id;
                keyValue = key.key;
                const client = rpc(() => ({
                    'x-api-key': keyValue,
                    'Vectorix-Expected-Organization-Id': f.org,
                })).retrieval;
                assert((await client.search(searchInput)).results.length);
                assert.equal(
                    (await client.citation(sourceInput)).chunkId,
                    hit.id
                );
                assert((await client.context(sourceInput)).passages.length);
                const response = await app.request(
                    `/api/v1/retrieval/collections/${collectionId}/context`,
                    {
                        method: 'POST',
                        headers: {
                            'x-api-key': keyValue,
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                            receipt: hit.source.receipt,
                            before: 0,
                            after: 0,
                        }),
                    }
                );
                assert.equal(response.status, 200);
                assert.equal((await response.json()).anchorChunkId, hit.id);
                await assert.rejects(
                    rpc(() => ({
                        'x-api-key': keyValue,
                        'Vectorix-Expected-Organization-Id': f.otherOrg,
                    })).retrieval.context(sourceInput)
                );
            }
        );
        await t.test(
            'foreign tenants, ungranted members, malformed/expired receipts and excessive windows fail closed',
            async () => {
                for (const client of [
                    f.other.client.retrieval,
                    f.reader.client.retrieval,
                ]) {
                    await assert.rejects(client.search(searchInput));
                    await assert.rejects(client.citation(sourceInput));
                    await assert.rejects(client.context(sourceInput));
                }
                for (const receipt of [
                    hit.id,
                    hit.source.receipt + 'x',
                    expiredReceipt(hit.source.receipt),
                ]) {
                    await assert.rejects(
                        api.context({ collectionId, receipt })
                    );
                    await assert.rejects(
                        api.citation({ collectionId, receipt })
                    );
                }
                for (const body of [
                    { receipt: hit.source.receipt, before: 3 },
                    { receipt: hit.source.receipt, after: -1 },
                    { receipt: hit.source.receipt, documentId: document.id },
                ]) {
                    const response = await app.request(
                        `/api/v1/retrieval/collections/${collectionId}/context`,
                        {
                            method: 'POST',
                            headers: {
                                ...f.owner.headers(),
                                'content-type': 'application/json',
                            },
                            body: JSON.stringify(body),
                        }
                    );
                    assert.equal(response.status, 400);
                }
                assert.equal(
                    (
                        await app.request(
                            `/api/v1/retrieval/collections/${collectionId}/context`,
                            {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({
                                    receipt: hit.source.receipt,
                                }),
                            }
                        )
                    ).status,
                    401
                );
            }
        );
        await t.test(
            'key collection scope revocation applies to existing receipts immediately',
            async () => {
                await prisma.apiKeyCollectionScope.delete({
                    where: { ['keyId_collectionId']: { keyId, collectionId } },
                });
                const client = rpc(() => ({ 'x-api-key': keyValue })).retrieval;
                await assert.rejects(client.search(searchInput));
                await assert.rejects(client.citation(sourceInput));
                await assert.rejects(client.context(sourceInput));
            }
        );
        await t.test(
            'a grant revoked during context read prevents the captured content from returning',
            async () => {
                await f.owner.rag.collections.setGrant({
                    id: collectionId,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                assert(
                    (await f.reader.client.retrieval.context(sourceInput))
                        .passages.length
                );
                const pool = new Pool({
                    connectionString: process.env.DATABASE_URL,
                    max: 2,
                });
                let pending: Promise<unknown> | undefined;
                try {
                    assert(
                        new URL(process.env.DATABASE_URL!).pathname.endsWith(
                            '_test'
                        )
                    );
                    const lock = await pool.connect();
                    try {
                        await lock.query('BEGIN');
                        const blocker = (
                            await lock.query<{ pid: number }>(
                                'SELECT pg_backend_pid() AS pid'
                            )
                        ).rows[0]!.pid;
                        // Prisma has no table-lock API; the disposable runner owns this database.
                        await lock.query(
                            'LOCK TABLE "Chunk" IN ACCESS EXCLUSIVE MODE'
                        );
                        pending = f.reader.client.retrieval
                            .context(sourceInput)
                            .then(
                                () => null,
                                (error: unknown) => error
                            );
                        await waitForChunkRead(pool, blocker);
                        await f.owner.rag.collections.removeGrant({
                            id: collectionId,
                            target: { type: 'member', id: f.readerMember },
                        });
                    } finally {
                        await lock.query('ROLLBACK');
                        lock.release();
                    }
                    assert(await pending);
                } finally {
                    await pool.end();
                }
            }
        );
        await t.test(
            'generation cutover preserves earlier exact-version citation and neighboring context while retained',
            async () => {
                const rebuilt = await f.owner.rag.indexing.rebuild({
                    collectionId,
                    expectedRevision: 1,
                    expectedActiveGenerationId: started.generationId,
                    requestId: randomUUID(),
                });
                await scanParent(fixture, rebuilt.generationId, 8);
                assert.equal(
                    (await f.owner.rag.indexing.status({ collectionId })).active
                        ?.id,
                    rebuilt.generationId
                );
                const retained = await api.context({
                    ...sourceInput,
                    before: 2,
                    after: 2,
                });
                assert.equal(retained.generationId, hit.generationId);
                assert.equal(
                    (await api.citation(sourceInput)).publicationId,
                    hit.publicationId
                );
                assert(
                    retained.passages.every(
                        (row) =>
                            row.generationId === hit.generationId &&
                            row.version === 1
                    )
                );
            }
        );
        await t.test(
            'expired retained-source holds deny context and citations before physical cleanup',
            async () => {
                const hold = await prisma.documentSourceHold.findUniqueOrThrow({
                    where: { indexedDocumentId: publication.id },
                });
                assert.equal(hold.state, 'RETIRED');
                try {
                    await prisma.documentSourceHold.update({
                        where: { indexedDocumentId: publication.id },
                        data: { retainUntil: new Date(0) },
                    });
                    await assert.rejects(api.context(sourceInput));
                    await assert.rejects(api.citation(sourceInput));
                } finally {
                    await prisma.documentSourceHold.update({
                        where: { indexedDocumentId: publication.id },
                        data: { retainUntil: hold.retainUntil },
                    });
                }
            }
        );
        await t.test(
            'current document detachment invalidates all earlier citations and context',
            async () => {
                await f.owner.rag.documents.setCollection({
                    id: document.id,
                    collectionId,
                    attached: false,
                });
                await assert.rejects(api.context(sourceInput));
                await assert.rejects(api.citation(sourceInput));
            }
        );
        await t.test(
            'child-only rich context projects 64 of 70 canonical source spans without parents or embedding calls',
            async () => {
                const childOnly = await f.owner.rag.collections.create({
                    name: 'Child-only rich retrieval',
                    grantCreatorRead: true,
                    profile: {
                        ...parentProfile('TOKEN_WINDOW'),
                        parentChild: false,
                        chunking: {
                            targetTokens: 1024,
                            minTokens: 512,
                            maxTokens: 2048,
                            overlapTokens: 0,
                            semanticPercentile: 75,
                            parentMaxTokens: 2048,
                        },
                    },
                });
                const bytes = paragraphDocument(
                    Array.from({ length: 70 }, () => 'forest')
                );
                const source = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(
                        [new Uint8Array(bytes)],
                        'retrieval-70-paragraphs.docx'
                    ),
                });
                await processDocumentIngestions(prisma, parseRichDocument);
                assert.equal(
                    (
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: source.versionId },
                        })
                    ).status,
                    'READY'
                );
                await f.owner.rag.documents.setCollection({
                    id: source.id,
                    collectionId: childOnly.id,
                    attached: true,
                });
                const initial = await f.owner.rag.indexing.start({
                    collectionId: childOnly.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                for (let pass = 0; pass < 50; pass++) {
                    const status = await f.owner.rag.indexing.status({
                        collectionId: childOnly.id,
                    });
                    if (status.active?.id === initial.generationId) break;
                    const tasks = await f.owner.rag.indexing.tasks({
                        collectionId: childOnly.id,
                        limit: 100,
                    });
                    assert(
                        !tasks.items.some((task) => task.status === 'FAILED')
                    );
                    await scanParent(fixture, initial.generationId, 1);
                }
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: childOnly.id,
                        })
                    ).active?.id,
                    initial.generationId
                );
                const stored = await prisma.chunk.findMany({
                    where: {
                        organizationId: f.org,
                        generationId: initial.generationId,
                    },
                    orderBy: { ordinal: 'asc' },
                    take: 2,
                });
                assert.equal(stored.length, 1);
                const child = stored[0]!;
                assert.equal(child.kind, 'CHILD');
                assert.equal(child.parentId, null);
                assert(Array.isArray(child.sourceSpans));
                assert.equal(child.sourceSpans.length, 70);
                const search = await api.search({
                    collectionId: childOnly.id,
                    query: 'forest',
                    strategy: 'LEXICAL',
                    topK: 1,
                    filters: {},
                });
                assert.equal(search.results.length, 1);
                const richHit = search.results[0]!;
                assert.equal(richHit.id, child.id);
                assert.equal(richHit.parentContext, undefined);
                const richInput = {
                    collectionId: childOnly.id,
                    receipt: richHit.source.receipt,
                };
                const beforeCalls = fixture.state.embedCalls;
                const citation = await api.citation(richInput);
                const context = await api.context({
                    ...richInput,
                    before: 2,
                    after: 2,
                });
                assert.equal(fixture.state.embedCalls, beforeCalls);
                assert.equal(citation.chunkId, child.id);
                assert.equal(citation.sourceSpans.length, 64);
                assert.equal(citation.sourceSpansTruncated, true);
                assert.deepEqual(
                    citation.sourceSpans,
                    child.sourceSpans.slice(0, 64)
                );
                assert.equal(context.passages.length, 1);
                const passage = context.passages[0]!;
                assert.equal(passage.chunkId, child.id);
                assert.equal(passage.relation, 'MATCH');
                assert.equal(passage.text, child.text);
                assert.equal(passage.sourceSpans.length, 64);
                assert.equal(passage.sourceSpansTruncated, true);
                assert.deepEqual(passage.sourceSpans, citation.sourceSpans);
                assert.equal(passage.source.receipt, richHit.source.receipt);
                assert.equal('parentContext' in passage, false);
            }
        );
    } finally {
        await fixture.close();
    }
}
