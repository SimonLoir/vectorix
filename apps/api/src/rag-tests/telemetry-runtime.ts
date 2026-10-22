import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { getRagTelemetry } from '@routers/rag/telemetry';
import { fixture as f } from './fixtures';
import { semanticText } from './semantic-fixtures';
import { startSyncCollection } from './sync-authority-fixtures';
import { createTelemetryFixture, dimension } from './telemetry-fixtures';

/** Real HTTP/native protocol/vector/object journeys; the local native vectors are synthetic, never paid/live-model quality evidence. */
export async function telemetryRuntimeTests(t: TestContext) {
    await t.test(
        'actual extraction, all three index strategies and search modes record phases, continuation/native success and explicit provider failure',
        async () => {
            const fixture = await createTelemetryFixture(
                'Actual domain boundaries'
            );
            try {
                const entries: Awaited<
                    ReturnType<typeof startSyncCollection>
                >[] = [];
                for (const strategy of [
                    'DOCUMENT_STRUCTURE',
                    'TOKEN_WINDOW',
                    'SEMANTIC',
                ] as const) {
                    const entry = await startSyncCollection(fixture, {
                        name: `Telemetry ${strategy}`,
                        strategy,
                        text: semanticText(70),
                        ...(entries[0]
                            ? { documentId: entries[0].documentId }
                            : {}),
                    });
                    entries.push(entry);
                }
                await getRagTelemetry(prisma).flush();
                const indexed = await f.owner.rag.telemetry.summary({});
                const extraction = dimension(indexed, 'EXTRACTION');
                assert(BigInt(extraction.counters.recordedSuccesses) >= 1n);
                assert(BigInt(extraction.counters.sourceReadBytes!) > 0n);
                assert(BigInt(extraction.counters.artifactWrittenBytes!) > 0n);
                assert.equal(extraction.counters.nativeValidatedBatches, '0');
                for (const workload of [
                    'INDEX_STRUCTURE',
                    'INDEX_TOKEN',
                    'INDEX_SEMANTIC',
                ] as const) {
                    const recorded = dimension(indexed, workload);
                    assert(BigInt(recorded.counters.recordedSuccesses) >= 1n);
                    assert(
                        BigInt(recorded.counters.nativeValidatedBatches) > 0n
                    );
                    assert(
                        recorded.phases.some(
                            (row) =>
                                row.name === 'FINAL_EMBED' &&
                                BigInt(row.samples) > 0n
                        )
                    );
                    assert.equal(
                        recorded.counters.knownBilledInputTokens,
                        null
                    );
                    assert(
                        BigInt(recorded.counters.unknownBilledTokenBatches) > 0n
                    );
                }
                const semantic = dimension(indexed, 'INDEX_SEMANTIC');
                assert(BigInt(semantic.counters.recordedContinuations) >= 2n);
                assert(
                    semantic.phases.some((row) => row.name === 'BOUNDARY_EMBED')
                );
                const entry = entries[2]!;
                const nativeWork = await prisma.embeddingWorkAttempt.findMany({
                    where: {
                        organizationId: f.org,
                        generationId: entry.generationId,
                        state: 'SUCCEEDED',
                    },
                });
                assert.equal(
                    BigInt(semantic.counters.nativeValidatedBatches),
                    BigInt(nativeWork.length)
                );
                assert.equal(
                    BigInt(semantic.counters.validatedVectors!),
                    nativeWork.reduce(
                        (sum, row) => sum + BigInt(row.inputCount),
                        0n
                    )
                );
                const beforeProbe = semantic.counters.nativeValidatedBatches;
                await f.owner.rag.indexing.models({
                    collectionId: entry.collection.id,
                    expectedRevision: 1,
                });
                await f.owner.rag.indexing.probe({
                    collectionId: entry.collection.id,
                    expectedRevision: 1,
                });
                await getRagTelemetry(prisma).flush();
                assert.equal(
                    dimension(
                        await f.owner.rag.telemetry.summary({}),
                        'INDEX_SEMANTIC'
                    ).counters.nativeValidatedBatches,
                    beforeProbe
                );
                for (const strategy of [
                    'LEXICAL',
                    'VECTOR',
                    'HYBRID',
                ] as const) {
                    const calls = fixture.state.embedCalls;
                    const result = await f.owner.rag.indexing.search({
                        collectionId: entry.collection.id,
                        query: 'forest',
                        strategy,
                        topK: 3,
                        filters: {},
                    });
                    assert(result.results.length > 0);
                    if (strategy === 'LEXICAL')
                        assert.equal(fixture.state.embedCalls, calls);
                }
                await getRagTelemetry(prisma).flush();
                const searched = await f.owner.rag.telemetry.summary({});
                for (const workload of [
                    'SEARCH_LEXICAL',
                    'SEARCH_VECTOR',
                    'SEARCH_HYBRID',
                ] as const) {
                    const recorded = dimension(searched, workload);
                    assert.equal(recorded.counters.recordedSuccesses, '1');
                    assert(
                        recorded.phases.some(
                            (row) =>
                                row.name === 'INTERNAL_PHASE_UNION' &&
                                row.samples === '1'
                        )
                    );
                    if (workload === 'SEARCH_LEXICAL') {
                        assert.equal(
                            recorded.counters.nativeValidatedBatches,
                            '0'
                        );
                        assert.equal(recorded.counters.validatedVectors, null);
                        assert(
                            !recorded.phases.some(
                                (row) => row.name === 'QUERY_EMBED'
                            )
                        );
                    } else
                        assert.equal(
                            recorded.counters.nativeValidatedBatches,
                            '1'
                        );
                }
                fixture.state.rejectEmbeddings = true;
                await assert.rejects(
                    f.owner.rag.indexing.search({
                        collectionId: entry.collection.id,
                        query: 'private failure text',
                        strategy: 'HYBRID',
                        topK: 3,
                        filters: {},
                    })
                );
                await getRagTelemetry(prisma).flush();
                const failed = dimension(
                    await f.owner.rag.telemetry.summary({}),
                    'SEARCH_HYBRID'
                );
                assert.equal(failed.counters.recordedFailures, '1');
                assert.equal(failed.counters.nativeFailedBatches, '1');
                assert.equal(failed.counters.nativeValidatedBatches, '1');
                assert(
                    failed.failures.some(
                        (row) => row.code === 'PROVIDER' && row.count === '1'
                    )
                );
                const encoded = JSON.stringify(failed);
                for (const sensitive of [
                    'synthetic-private-provider-body',
                    'private failure text',
                    'fixture:latest',
                    entry.collection.id,
                    entry.documentId,
                ])
                    assert(!encoded.includes(sensitive));
            } finally {
                await fixture.close();
            }
        }
    );
}
