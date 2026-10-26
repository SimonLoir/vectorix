import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import { prisma } from '../../packages/db/src/index';
import { auth } from '../../packages/auth/src/index';
import { getMemberPermissions } from '../../packages/auth/src/permissions/resolve';
import type { AuthorizedContext } from '../../packages/routers/utils/src/authorized';
import {
    rerank,
    validateRerankingInput,
} from '../../packages/reranking/src/index';
import {
    claimRerankRequest,
    admitRerankDispatch,
    settleRerankValidated,
    settleRerankFailure,
    releaseRerankClaim,
    recheckRerankAuthority,
    type RerankRun,
} from '../../packages/routers/rag/src/services/reranking/accounting';
import { configureRerankProfile } from '../../packages/routers/rag/src/services/reranking/profile';
import { processRerankCleanup } from '../../packages/routers/rag/src/services/reranking/cleanup';
import { utcDay } from '../../packages/routers/rag/src/services/reranking/limits';
import { fixture as f } from '../../apps/api/src/rag-tests/fixtures';
import {
    createSemanticFixture,
    scanSemantic,
} from '../../apps/api/src/rag-tests/semantic-fixtures';

const require = createRequire(
    new URL('../../apps/api/package.json', import.meta.url)
);
const logger: AuthorizedContext['logger'] = require('pino')({ enabled: false });
const variables = [
    'VECTORIX_DEFAULT_COHERE_ENDPOINT',
    'VECTORIX_DEFAULT_COHERE_API_KEY',
    'VECTORIX_DEFAULT_VOYAGE_ENDPOINT',
    'VECTORIX_DEFAULT_VOYAGE_API_KEY',
    'VECTORIX_RERANKING_ALLOWED_ENDPOINTS',
    'VECTORIX_DEFAULT_RAG_RERANK_REQUESTS_PER_DAY',
    'VECTORIX_DEFAULT_RAG_RERANK_PREPARED_BYTES_PER_DAY',
    'VECTORIX_DEFAULT_RAG_RERANK_CONCURRENT_REQUESTS',
] as const;
const failure = (code: string) => (error: unknown) =>
    Boolean(
        error &&
        typeof error === 'object' &&
        'data' in error &&
        error.data &&
        typeof error.data === 'object' &&
        'errorCode' in error.data &&
        error.data.errorCode === code
    );
const input = {
    model: 'rerank-v5.0-fast',
    query: 'Synthetic accounting query',
    documents: ['Synthetic one', 'Synthetic two'],
};

/**
 * Called by the existing catalog suite after native authentication setup. This
 * exercises the production admission/settlement functions, not a SQL imitation
 * of their policy. The only HTTP provider is this test's owned loopback server.
 */
export async function rerankingAccountingTests(t: TestContext) {
    const destination = new URL(
        process.env.DATABASE_URL ?? 'postgresql://localhost/'
    );
    assert.equal(destination.hostname, '127.0.0.1');
    assert.equal(destination.pathname, '/vectorix_catalog_test');
    const previous = Object.fromEntries(
        variables.map((name) => [name, process.env[name]])
    );
    let providerCalls = 0;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            documents: string[];
        };
        assert.equal(request.url, '/v2/rerank');
        providerCalls++;
        response.setHeader('content-type', 'application/json');
        response.end(
            JSON.stringify({
                results: body.documents.map((_text, index) => ({
                    index,
                    ['relevance_score']: 1 / (index + 1),
                })),
                meta: {
                    tokens: { ['input_tokens']: 11 },
                    ['billed_units']: {
                        ['input_tokens']: 0.25,
                        ['search_units']: 1,
                    },
                },
            })
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT = endpoint;
    process.env.VECTORIX_DEFAULT_COHERE_API_KEY = 'synthetic-accounting-only';
    process.env.VECTORIX_DEFAULT_VOYAGE_ENDPOINT = endpoint;
    process.env.VECTORIX_DEFAULT_VOYAGE_API_KEY = 'synthetic-accounting-only';
    process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS = '';
    process.env.VECTORIX_DEFAULT_RAG_RERANK_REQUESTS_PER_DAY = '500';
    process.env.VECTORIX_DEFAULT_RAG_RERANK_PREPARED_BYTES_PER_DAY =
        '268435456';
    process.env.VECTORIX_DEFAULT_RAG_RERANK_CONCURRENT_REQUESTS = '4';
    let fixture: Awaited<ReturnType<typeof createSemanticFixture>> | undefined;
    try {
        fixture = await createSemanticFixture(
            'Reranking mandatory accounting',
            true
        );
        const collection = await fixture.collection(
            'Reranking accounting empty active index'
        );
        const started = await f.owner.rag.indexing.start({
            collectionId: collection.id,
            expectedRevision: 1,
            requestId: randomUUID(),
        });
        await scanSemantic(fixture, started.generationId, 4);
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId: collection.id }))
                .active?.id,
            started.generationId
        );
        const headers = new Headers(f.owner.headers());
        const native = await auth.api.getSession({ headers });
        assert(
            native?.user &&
                native.session.activeOrganizationId === fixture.organizationId
        );
        const permissions = await getMemberPermissions(
            fixture.organizationId,
            native.user.id
        );
        assert(permissions);
        const context: AuthorizedContext = {
            db: prisma,
            headers,
            logger,
            key: null,
            user: native.user,
            session: native.session,
            organizationId: fixture.organizationId,
            permissions: permissions.permissions,
            legacyApiKey: false,
        };
        let revision = (
            await configureRerankProfile(context, {
                collectionId: collection.id,
                expectedRevision: 0,
                enabled: true,
                provider: 'COHERE',
                model: input.model,
                candidatePool: 50,
            })
        ).revision;
        const claim = (requestId: string = randomUUID()) =>
            claimRerankRequest(context, {
                collectionId: collection.id,
                requestId,
                expectedRerankRevision: revision,
            });
        const usage = () =>
            prisma.rerankUsageDay.findMany({
                where: {
                    organizationId: context.organizationId,
                    day: utcDay(),
                },
            });
        const release = (run: RerankRun) => releaseRerankClaim(prisma, run);

        await t.test(
            'claim retains canonical UUID replay identity without provider or daily debit',
            async () => {
                const requestId = 'abcdef12-3456-4789-8abc-def012345678';
                const run = await claim(requestId);
                try {
                    await assert.rejects(
                        claim(requestId),
                        failure('RERANK_REQUEST_REPLAY')
                    );
                    await assert.rejects(
                        claim(requestId.toUpperCase()),
                        failure('RERANK_REQUEST_REPLAY')
                    );
                    assert.equal(
                        await prisma.rerankRequest.count({
                            where: { organizationId: context.organizationId },
                        }),
                        1
                    );
                    assert.equal((await usage()).length, 0);
                    assert.equal(providerCalls, 0);
                } finally {
                    await release(run);
                }
            }
        );

        await t.test(
            'two overlapping actual claims serialize on the organization fence and admit one capacity slot',
            async () => {
                process.env.VECTORIX_DEFAULT_RAG_RERANK_CONCURRENT_REQUESTS =
                    '1';
                let unlock = () => {};
                let arrived: (pid: number) => void = () => {};
                const held = new Promise<void>((resolve) => {
                    unlock = resolve;
                });
                const ready = new Promise<number>((resolve) => {
                    arrived = resolve;
                });
                const blocker = prisma.$transaction(
                    async (tx) => {
                        await tx.organizationRerankAccounting.update({
                            where: { organizationId: context.organizationId },
                            data: { lockRevision: { increment: 1n } },
                        });
                        const [backend] = await tx.$queryRaw<
                            { pid: number }[]
                        >`SELECT pg_backend_pid()::integer AS pid`;
                        assert(backend);
                        arrived(backend.pid);
                        await held;
                    },
                    { timeout: 5000 }
                );
                let result: PromiseSettledResult<RerankRun>[] = [];
                try {
                    const pid = await Promise.race([
                        ready,
                        blocker.then(() => {
                            throw new Error(
                                'The controlled lock ended before its admission signal.'
                            );
                        }),
                    ]);
                    const pending = Promise.allSettled([claim(), claim()]);
                    try {
                        let blocked = false;
                        for (let attempt = 0; attempt < 200; attempt++) {
                            // PostgreSQL lock diagnostics have no Prisma model. Observe real
                            // overlap before releasing the fixture lock; no policy is mocked.
                            const [row] = await prisma.$queryRaw<
                                { count: number }[]
                            >`SELECT count(*)::integer AS count FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
                            if (row && row.count >= 2) {
                                blocked = true;
                                break;
                            }
                            await new Promise((resolve) =>
                                setTimeout(resolve, 5)
                            );
                        }
                        assert(
                            blocked,
                            'Both real claim transactions must be blocked before release.'
                        );
                    } finally {
                        unlock();
                        await blocker;
                        result = await pending;
                    }
                    const winners = result.filter(
                        (row) => row.status === 'fulfilled'
                    );
                    const refusals = result.filter(
                        (row) => row.status === 'rejected'
                    );
                    assert.equal(winners.length, 1);
                    assert.equal(refusals.length, 1);
                    assert(failure('RERANK_CAPACITY')(refusals[0]!.reason));
                    assert.equal(providerCalls, 0);
                } finally {
                    unlock();
                    await blocker;
                    await Promise.all(
                        result.flatMap((row) =>
                            row.status === 'fulfilled'
                                ? [release(row.value)]
                                : []
                        )
                    );
                    process.env.VECTORIX_DEFAULT_RAG_RERANK_CONCURRENT_REQUESTS =
                        '4';
                }
            }
        );

        await t.test(
            'concurrent dispatch of one receipt debits once; validated native usage settles once',
            async () => {
                const run = await claim();
                const prepared = validateRerankingInput('COHERE', input);
                const decisions = await Promise.allSettled([
                    admitRerankDispatch(context, run, prepared),
                    admitRerankDispatch(context, run, prepared),
                ]);
                assert.equal(
                    decisions.filter((row) => row.status === 'fulfilled')
                        .length,
                    1
                );
                const rejected = decisions.find(
                    (row) => row.status === 'rejected'
                );
                assert(
                    rejected?.status === 'rejected' &&
                        failure('RERANK_REQUEST_REPLAY')(rejected.reason)
                );
                const [before] = await usage();
                assert(before);
                assert.equal(before.dispatchedRequests, 1n);
                assert.equal(
                    before.dispatchedPreparedBytes,
                    BigInt(prepared.preparedInputBytes)
                );
                assert.equal(before.unknownProviderInputTokenRequests, 1n);
                const nativeResult = await rerank(
                    {
                        provider: 'COHERE',
                        endpoint,
                        apiKey: 'synthetic-accounting-only',
                    },
                    input
                );
                assert.equal(providerCalls, 1);
                await Promise.all([
                    settleRerankValidated(prisma, run, nativeResult),
                    settleRerankValidated(prisma, run, nativeResult),
                ]);
                await settleRerankFailure(prisma, run, 'PROVIDER_TIMEOUT');
                const [after] = await usage();
                assert(after);
                assert.equal(after.dispatchedRequests, 1n);
                assert.equal(after.validatedRequests, 1n);
                assert.equal(after.validatedDocuments, 2n);
                assert.equal(after.knownProviderInputTokens, 11n);
                assert.equal(after.unknownProviderInputTokenRequests, 0n);
                assert.equal(after.knownBilledInputTokens, 0.25);
                assert.equal(after.knownBilledSearchUnits, 1);
                assert.equal(after.unknownBilledInputTokenRequests, 0n);
                assert.equal(after.unknownBilledSearchUnitRequests, 0n);
                assert.equal(
                    after.observedNativeDurationMicros,
                    BigInt(Math.round(nativeResult.durationMs * 1000))
                );
                assert.equal(
                    (
                        await prisma.rerankRequest.findUniqueOrThrow({
                            where: { id: run.id },
                        })
                    ).state,
                    'VALIDATED'
                );
            }
        );

        await t.test(
            'a dispatched timeout releases capacity, retains its debit and accepts validated late usage after revocation',
            async () => {
                const run = await claim();
                await admitRerankDispatch(
                    context,
                    run,
                    validateRerankingInput('COHERE', input)
                );
                const row = await prisma.rerankRequest.findUniqueOrThrow({
                    where: { id: run.id },
                });
                await processRerankCleanup(
                    prisma,
                    new Date(row.expiresAt.getTime() + 1)
                );
                const expired = await prisma.rerankRequest.findUniqueOrThrow({
                    where: { id: run.id },
                });
                assert.equal(expired.state, 'UNCERTAIN');
                assert(expired.capacityReleasedAt);
                await recheckRerankAuthority(context, run);
                const grant =
                    await prisma.collectionMemberGrant.findUniqueOrThrow({
                        where: {
                            ['collectionId_memberId']: {
                                collectionId: collection.id,
                                memberId: f.ownerMember,
                            },
                        },
                    });
                await prisma.collectionMemberGrant.update({
                    where: {
                        ['collectionId_memberId']: {
                            collectionId: collection.id,
                            memberId: f.ownerMember,
                        },
                    },
                    data: { read: false },
                });
                try {
                    await assert.rejects(recheckRerankAuthority(context, run));
                    const late = await rerank(
                        {
                            provider: 'COHERE',
                            endpoint,
                            apiKey: 'synthetic-accounting-only',
                        },
                        input
                    );
                    await settleRerankValidated(prisma, run, late);
                    await assert.rejects(recheckRerankAuthority(context, run));
                    const settled =
                        await prisma.rerankRequest.findUniqueOrThrow({
                            where: { id: run.id },
                        });
                    assert.equal(settled.state, 'VALIDATED');
                    assert.equal(settled.providerInputTokens, 11n);
                    assert.equal(
                        settled.capacityReleasedAt?.getTime(),
                        expired.capacityReleasedAt.getTime()
                    );
                    const [daily] = await usage();
                    assert(daily);
                    assert.equal(daily.dispatchedRequests, 2n);
                    assert.equal(daily.validatedRequests, 2n);
                } finally {
                    await prisma.collectionMemberGrant.update({
                        where: {
                            ['collectionId_memberId']: {
                                collectionId: collection.id,
                                memberId: f.ownerMember,
                            },
                        },
                        data: { read: grant.read },
                    });
                }
            }
        );

        await t.test(
            'daily admission limit is shared across providers and refuses before another native call',
            async () => {
                process.env.VECTORIX_DEFAULT_RAG_RERANK_REQUESTS_PER_DAY = '2';
                revision = (
                    await configureRerankProfile(context, {
                        collectionId: collection.id,
                        expectedRevision: revision,
                        enabled: true,
                        provider: 'VOYAGE',
                        model: 'rerank-3',
                        candidatePool: 50,
                    })
                ).revision;
                const calls = providerCalls;
                await assert.rejects(claim(), failure('RERANK_DAILY_LIMIT'));
                const rows = await usage();
                assert.equal(rows.length, 1);
                assert.equal(rows[0]!.provider, 'COHERE');
                assert.equal(rows[0]!.dispatchedRequests, 2n);
                assert.equal(providerCalls, calls);
                process.env.VECTORIX_DEFAULT_RAG_RERANK_REQUESTS_PER_DAY =
                    '500';
            }
        );

        await t.test(
            'pre-dispatch failed and skipped receipts consume neither daily budget nor provider calls',
            async () => {
                const before = await usage();
                const calls = providerCalls;
                const skipped = await claim();
                await release(skipped);
                const failed = await claim();
                await settleRerankFailure(prisma, failed, 'INPUT_TOO_LARGE');
                await settleRerankFailure(
                    prisma,
                    failed,
                    'arbitrary private provider message'
                );
                await assert.rejects(
                    admitRerankDispatch(context, failed, {
                        candidateCount: 2,
                        preparedInputBytes: 8,
                    }),
                    failure('RERANK_REQUEST_REPLAY')
                );
                const saved = await prisma.rerankRequest.findUniqueOrThrow({
                    where: { id: failed.id },
                });
                assert.equal(saved.errorCode, 'INPUT_TOO_LARGE');
                assert.equal(saved.dispatchedAt, null);
                assert.equal(saved.preparedInputBytes, 0n);
                assert.deepEqual(await usage(), before);
                assert.equal(providerCalls, calls);
            }
        );

        await t.test(
            'two different actual dispatches cannot race past the remaining daily byte budget',
            async () => {
                const before = await usage();
                const bytes = before.reduce(
                    (sum, row) => sum + row.dispatchedPreparedBytes,
                    0n
                );
                const requests = before.reduce(
                    (sum, row) => sum + row.dispatchedRequests,
                    0n
                );
                const prepared = validateRerankingInput('VOYAGE', {
                    model: 'rerank-3',
                    query: 'x',
                    documents: ['one', 'two'],
                });
                assert.equal(prepared.preparedInputBytes, 8);
                const calls = providerCalls;
                process.env.VECTORIX_DEFAULT_RAG_RERANK_PREPARED_BYTES_PER_DAY =
                    String(bytes + 8n);
                const runs = await Promise.all([claim(), claim()]);
                try {
                    const decisions = await Promise.allSettled(
                        runs.map((run) =>
                            admitRerankDispatch(context, run, prepared)
                        )
                    );
                    assert.equal(
                        decisions.filter((row) => row.status === 'fulfilled')
                            .length,
                        1
                    );
                    const refused = decisions.find(
                        (row) => row.status === 'rejected'
                    );
                    assert(
                        refused?.status === 'rejected' &&
                            failure('RERANK_DAILY_LIMIT')(refused.reason)
                    );
                    const after = await usage();
                    assert.equal(
                        after.reduce(
                            (sum, row) => sum + row.dispatchedPreparedBytes,
                            0n
                        ),
                        bytes + 8n
                    );
                    assert.equal(
                        after.reduce(
                            (sum, row) => sum + row.dispatchedRequests,
                            0n
                        ),
                        requests + 1n
                    );
                    assert.equal(providerCalls, calls);
                } finally {
                    for (const run of runs) {
                        await settleRerankFailure(
                            prisma,
                            run,
                            'PROVIDER_UNAVAILABLE'
                        );
                        await release(run);
                    }
                    process.env.VECTORIX_DEFAULT_RAG_RERANK_PREPARED_BYTES_PER_DAY =
                        '268435456';
                }
            }
        );
    } finally {
        try {
            await fixture?.close();
        } finally {
            for (const name of variables) {
                if (previous[name] === undefined) delete process.env[name];
                else process.env[name] = previous[name];
            }
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
}
