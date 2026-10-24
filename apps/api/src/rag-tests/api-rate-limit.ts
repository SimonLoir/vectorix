import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Redis } from 'ioredis';
import { prisma } from '@repo/db';
import {
    VECTORIX_API_V1,
    VECTORIX_API_VERSION_HEADER,
    VECTORIX_API_REVISION_HEADER,
} from '@repo/api/versioning';
import { connection } from '@repo/queues';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { parseApiRateLimits } from '@routers/utils/api-rate-limit';
import { app } from '../app';
import { fixture as f, rpc } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';

const prefix = 'vectorix:rate-limit:fixed:v1:';

/**
 * Real application middleware, resource guards, Redis and native HTTP protocols;
 * embedding vectors come only from the controlled fixture, not a live model.
 * Redis writes are restricted to one newly issued test key's personal counter.
 */
export async function apiRateLimitTests(t: TestContext): Promise<void> {
    const database = new URL(
        process.env.DATABASE_URL ?? 'postgresql://invalid'
    );
    const target = new URL(process.env.REDIS_URL ?? 'redis://invalid');
    assert.ok(
        database.hostname === '127.0.0.1' &&
            database.pathname === '/vectorix_catalog_test' &&
            target.protocol === 'redis:' &&
            target.hostname === '127.0.0.1' &&
            target.port !== '' &&
            ['', '/0'].includes(target.pathname),
        'Rate-limit journeys require the owned loopback catalog stores.'
    );
    const limits = parseApiRateLimits(process.env);
    assert.ok(
        limits.principal > 0 &&
            limits.principalProvider > 0 &&
            limits.organizationProvider > 0,
        'Native rate-limit coverage requires all three enabled test budgets.'
    );
    const inspector = new Redis({
        ...connection,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
        connectTimeout: 2000,
        commandTimeout: 1000,
        maxRetriesPerRequest: 0,
    });
    inspector.on('error', () => {});
    const sharedKey = `${prefix}api-provider-org:${f.org}`;
    let issuedId: string | undefined;
    let personalKey: string | undefined;
    let environment:
        Awaited<ReturnType<typeof createIndexingFixture>> | undefined;
    async function count(key: string): Promise<number> {
        const raw = await inspector.get(key);
        if (raw === null) return 0;
        assert.ok(
            /^\d+$/u.test(raw),
            'An owned Redis counter must be numeric.'
        );
        const value = Number(raw);
        assert.ok(Number.isSafeInteger(value) && value > 0);
        return value;
    }
    // Never delete or retime the organization counter. If its natural boundary
    // is imminent, wait for expiry before asserting exact before/after deltas.
    async function settleWindowBoundary(): Promise<void> {
        const remaining = await inspector.pttl(sharedKey);
        if (remaining < 0 || remaining >= 15_000) return;
        const deadline = performance.now() + 16_000;
        for (let wake = 0; wake < 64; wake++) {
            const ttl = await inspector.pttl(sharedKey);
            if (ttl < 0) return;
            assert.ok(performance.now() < deadline);
            await sleep(Math.max(1, Math.ceil(ttl + 10)));
        }
        assert.fail('The owned fixed-window boundary did not expire in time.');
    }
    try {
        await inspector.connect();
        environment = await createIndexingFixture();
        const collection = await environment.collection(
            'API admission boundary'
        );
        const document = await environment.upload(
            'The fox preserves an exact source. Le renard conserve une source exacte.\n',
            'api-admission.txt',
            collection.id
        );
        const started = await f.owner.rag.indexing.start({
            collectionId: collection.id,
            expectedRevision: collection.configurationRevision,
            requestId: randomUUID(),
        });
        // Activation visits only ten live generations per scan. Earlier catalog
        // journeys retain their real rows, so eight local ticks cannot establish
        // readiness here. Advance only genuine scans, never task dates or state.
        const live = await prisma.indexGeneration.count({
            where: {
                status: { in: ['BUILDING', 'ACTIVE'] },
                collection: { deletedAt: null },
            },
        });
        const passes = 12 + Math.ceil(live / 10) * 2;
        const setupDeadline = performance.now() + 60_000;
        let activated = false;
        for (
            let pass = 0;
            pass < passes && performance.now() < setupDeadline;
            pass++
        ) {
            await environment.scan(1);
            const generation = await prisma.indexGeneration.findFirstOrThrow({
                where: {
                    id: started.generationId,
                    organizationId: f.org,
                    collectionId: collection.id,
                },
                select: { status: true },
            });
            if (generation.status === 'ACTIVE') {
                activated = true;
                break;
            }
        }
        if (!activated) {
            const tasks = await prisma.indexTask.findMany({
                where: {
                    organizationId: f.org,
                    collectionId: collection.id,
                    generationId: started.generationId,
                },
                select: {
                    kind: true,
                    status: true,
                    stage: true,
                    errorCode: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 20,
            });
            assert.fail(
                `The owned rate-limit generation did not activate within its bounded real scans: ${JSON.stringify(tasks)}`
            );
        }
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId: collection.id }))
                .active?.id,
            started.generationId
        );
        const activeEnvironment = environment;
        const search = (strategy: 'VECTOR' | 'LEXICAL', empty = false) =>
            f.owner.rag.indexing.search({
                collectionId: collection.id,
                query: 'fox',
                strategy,
                topK: 3,
                filters: empty
                    ? { tags: ['absent-admission-fixture-tag'] }
                    : {},
            });
        const snapshot = async () => ({
            active: await prisma.collection.findUniqueOrThrow({
                where: { id: collection.id },
                select: {
                    activeGenerationId: true,
                    configurationRevision: true,
                },
            }),
            chunks: await prisma.chunk.count({
                where: {
                    organizationId: f.org,
                    generationId: started.generationId,
                },
            }),
            audits: await prisma.ragAuditLog.count({
                where: { organizationId: f.org, targetId: collection.id },
            }),
        });
        const issued = await f.owner.client.admin.organization.apiKeys.create({
            name: 'Rate admission settings only',
            permissions: { settings: ['read'] },
        });
        issuedId = issued.id;
        personalKey = `${prefix}api:${f.org}:key:${issued.id}`;
        const limited = rpc(() => ({
            'x-api-key': issued.key,
            'Vectorix-Expected-Organization-Id': f.org,
        }));
        assert.equal((await limited.admin.organization.get({})).id, f.org);

        await t.test(
            'a genuine owner provider request debits the shared budget once',
            async () => {
                await settleWindowBoundary();
                const before = await count(sharedKey);
                const calls = activeEnvironment.state.embedCalls;
                const result = await search('VECTOR');
                assert.ok(
                    result.results.some(
                        (item) => item.documentId === document.id
                    )
                );
                assert.equal(result.generationId, started.generationId);
                assert.equal(await count(sharedKey), before + 1);
                assert.equal(activeEnvironment.state.embedCalls, calls + 1);
            }
        );

        await t.test(
            'scope and actual collection-grant denials preserve shared admission and serving state',
            async () => {
                await settleWindowBoundary();
                const before = await count(sharedKey);
                const calls = activeEnvironment.state.embedCalls;
                const original = await snapshot();
                await assert.rejects(
                    limited.admin.rag.indexing.search({
                        collectionId: collection.id,
                        query: 'fox',
                        strategy: 'VECTOR',
                        topK: 3,
                        filters: {},
                    }),
                    { code: 'FORBIDDEN' }
                );
                const reader = await prisma.member.findUniqueOrThrow({
                    where: { id: f.readerMember },
                    select: { userId: true },
                });
                const access = await getMemberPermissions(
                    f.org,
                    reader.userId,
                    prisma
                );
                assert.ok(access?.permissions.ragCollection?.includes('read'));
                assert.ok(access?.permissions.ragLibrary?.includes('read'));
                assert.equal(
                    await prisma.collectionMemberGrant.count({
                        where: {
                            organizationId: f.org,
                            collectionId: collection.id,
                            memberId: f.readerMember,
                            read: true,
                        },
                    }),
                    0
                );
                await assert.rejects(
                    f.reader.rag.indexing.search({
                        collectionId: collection.id,
                        query: 'fox',
                        strategy: 'VECTOR',
                        topK: 3,
                        filters: {},
                    }),
                    { code: 'NOT_FOUND' }
                );
                assert.equal(await count(sharedKey), before);
                assert.equal(activeEnvironment.state.embedCalls, calls);
                assert.deepEqual(await snapshot(), original);
                assert.ok((await search('VECTOR')).results.length > 0);
                assert.equal(await count(sharedKey), before + 1);
            }
        );

        await t.test(
            'lexical and empty-eligible vector searches skip provider admission and native dispatch',
            async () => {
                await settleWindowBoundary();
                const before = await count(sharedKey);
                const calls = activeEnvironment.state.embedCalls;
                assert.ok(
                    (await search('LEXICAL')).results.some(
                        (item) => item.documentId === document.id
                    )
                );
                assert.deepEqual((await search('VECTOR', true)).results, []);
                assert.equal(await count(sharedKey), before);
                assert.equal(activeEnvironment.state.embedCalls, calls);
            }
        );

        await t.test(
            'actual RPC and REST personal refusals return 429 and Retry-After without shared debit',
            async () => {
                await settleWindowBoundary();
                const before = await count(sharedKey);
                const calls = activeEnvironment.state.embedCalls;
                const original = await snapshot();
                assert.ok(personalKey);
                await inspector.set(
                    personalKey,
                    String(limits.principal),
                    'PX',
                    60_000
                );
                assert.equal(await count(personalKey), limits.principal);
                const input = {
                    collectionId: collection.id,
                    query: 'fox',
                    strategy: 'VECTOR',
                    topK: 3,
                    filters: {},
                };
                for (const [url, body] of [
                    [
                        'http://localhost:3001/rpc/v1/admin/rag/indexing/search',
                        { json: input },
                    ],
                    [
                        `http://localhost:3001/api/v1/admin/rag/collections/${collection.id}/search`,
                        input,
                    ],
                ] as const) {
                    const response = await app.request(url, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            'x-api-key': issued.key,
                            'Vectorix-Expected-Organization-Id': f.org,
                        },
                        body: JSON.stringify(body),
                    });
                    assert.equal(response.status, 429);
                    assert.equal(
                        response.headers.get(VECTORIX_API_VERSION_HEADER),
                        String(VECTORIX_API_V1.major)
                    );
                    assert.equal(
                        response.headers.get(VECTORIX_API_REVISION_HEADER),
                        String(VECTORIX_API_V1.revision)
                    );
                    const retry = response.headers.get('retry-after');
                    assert.ok(retry && /^\d+$/u.test(retry));
                    assert.ok(Number(retry) >= 1 && Number(retry) <= 60);
                    const decoded: unknown = await response.json();
                    assert.ok(decoded && typeof decoded === 'object');
                    const payload = 'json' in decoded ? decoded.json : decoded;
                    assert.ok(
                        payload &&
                            typeof payload === 'object' &&
                            'code' in payload
                    );
                    assert.equal(payload.code, 'TOO_MANY_REQUESTS');
                    assert.equal(await count(sharedKey), before);
                    assert.equal(await count(personalKey), limits.principal);
                }
                assert.equal(activeEnvironment.state.embedCalls, calls);
                assert.deepEqual(await snapshot(), original);
            }
        );
    } finally {
        try {
            if (personalKey) await inspector.del(personalKey);
            if (issuedId)
                await f.owner.post('api-key/delete', {
                    configId: 'org',
                    keyId: issuedId,
                });
        } finally {
            inspector.disconnect();
            await environment?.close();
        }
    }
}
