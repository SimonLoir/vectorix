import assert from 'node:assert/strict';
import {
    createCipheriv,
    createHash,
    randomBytes,
    randomUUID,
} from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { IndexTask } from '@repo/db';
import { prisma } from '@repo/db';
import {
    decrypt,
    needsReencryption,
    rerankEndpointSecretContext,
} from '@routers/utils/encryption';
import {
    encryptedColumns,
    reencryptSecretColumns,
} from '@routers/utils/secret-reencryption';
import type { VectorixApiV1Client, VectorixApiV1Outputs } from '@repo/api';
import { fixture as f, readGrant, rpc } from './fixtures';
import { createParentFixture, scanParent } from './parent-fixtures';
import { semanticLatch } from './semantic-fixtures';
import { createTeiRerankingFixture, teiModel } from './tei-reranking-fixture';

type RagApi = VectorixApiV1Client['admin']['rag'];
type SearchResult =
    VectorixApiV1Outputs['admin']['rag']['indexing']['search']['results'][number];
const variables = [
    'VECTORIX_DEFAULT_TEI_ENDPOINT',
    'VECTORIX_DEFAULT_TEI_API_KEY',
    'VECTORIX_RERANKING_ALLOWED_ENDPOINTS',
] as const;

function failure(expected: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: expected });
        assert(!JSON.stringify(error).includes('tei-rotated-native-key'));
        return true;
    };
}

/** Actual API/auth/storage/indexing with owned native TEI HTTP; reported metadata and fixture scores are not hosted quality evidence. */
export async function teiRerankingTests(t: TestContext) {
    const fixture = await createParentFixture('Native TEI reranking', true);
    const native = await createTeiRerankingFixture();
    const alternate = await createTeiRerankingFixture();
    const previous = Object.fromEntries(
        variables.map((name) => [name, process.env[name]])
    );
    process.env.VECTORIX_DEFAULT_TEI_ENDPOINT = native.endpoint;
    process.env.VECTORIX_DEFAULT_TEI_API_KEY = '';
    process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS = `${native.endpoint},${alternate.endpoint}`;
    const memberId = f.readerMember;
    let previousRole: string | undefined;
    let roleId: string | undefined;
    let scopedApi: RagApi | undefined;
    const readerPermissions = {
        ragCollection: ['read'],
        ragLibrary: ['read'],
        ragRerank: ['use'],
        apiKey: ['create', 'read', 'update'],
    };
    try {
        const collection = await fixture.collection();
        const collectionId = collection.id;
        const normalText = Array.from(
            { length: 12 },
            (_v, index) =>
                `Shared forest river garden passage ${index} protects the animals and their familiar shelter.`
        ).join(' ');
        const targetText = Array.from(
            { length: 10 },
            (_v, index) =>
                `Shared prioritypassage forêt française prioritypassage policy ${index} retains the exact bilingual source.`
        ).join(' ');
        const first = await fixture.upload(
            normalText,
            'tei-baseline.txt',
            collectionId
        );
        const target = await fixture.upload(
            targetText,
            'tei-priority.txt',
            collectionId
        );
        fixture.state.vectorForText = (text) =>
            text.includes('prioritypassage') ? [0, 1, 0] : [1, 0, 0];
        const started = await f.owner.rag.indexing.start({
            collectionId,
            expectedRevision: collection.configurationRevision,
            requestId: randomUUID(),
        });
        for (let pass = 0; pass < 50; pass++) {
            await scanParent(fixture, started.generationId, 1);
            const failed: Pick<IndexTask, 'kind' | 'stage' | 'errorCode'>[] =
                await prisma.indexTask.findMany({
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
                'The owned TEI fixture must activate without worker failures.'
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
            select: { id: true, text: true, parentId: true },
            take: 33,
        });
        assert(children.length > 2 && children.length <= 32);
        assert(children.every((row) => row.parentId));
        const childTexts = new Set(children.map((row) => row.text));
        let revision = 0;
        let model = teiModel;
        const search = (
            extra: Partial<
                Parameters<RagApi['reranking']['extended']['search']>[0]
            > = {}
        ) => ({
            collectionId,
            query: 'Shared question',
            strategy: 'VECTOR' as const,
            topK: 5,
            filters: {},
            requestId: randomUUID(),
            expectedRerankRevision: revision,
            compare: true,
            ...extra,
        });
        const configure = async (
            extra: Partial<
                Parameters<RagApi['reranking']['extended']['configure']>[0]
            > = {}
        ) => {
            const result = await f.owner.rag.reranking.extended.configure({
                collectionId,
                expectedRevision: revision,
                enabled: true,
                provider: 'TEI',
                model,
                candidatePool: 32,
                ...extra,
            });
            revision = result.revision;
            return result;
        };
        const ordinary = () =>
            f.owner.rag.indexing.search({
                collectionId,
                query: 'Shared question',
                strategy: 'VECTOR',
                topK: 5,
                filters: {},
            });
        const dispatches = async () => {
            const usage = await prisma.rerankUsageDay.aggregate({
                where: { organizationId: f.org },
                _sum: { dispatchedRequests: true },
            });
            return usage._sum.dispatchedRequests ?? 0n;
        };
        const oldCredentials = await f.owner.rag.credentials.list({
            query: '',
            offset: 0,
            limit: 100,
        });

        await t.test(
            'ordinary search and default-off profile perform no TEI operation; absent organization settings use complete platform metadata',
            async () => {
                assert.equal(
                    (
                        await f.owner.rag.reranking.extended.profile({
                            collectionId,
                        })
                    ).enabled,
                    false
                );
                assert((await ordinary()).results.length > 0);
                assert.equal(native.state.infoCalls, 0);
                assert.equal(native.state.calls.length, 0);
                const configured = await configure();
                assert.equal(
                    configured.configuration?.bindingSource,
                    'PLATFORM'
                );
                assert.equal(
                    configured.configuration?.runtimeSnapshot?.modelRevision,
                    'a'.repeat(40)
                );
                assert.equal(native.state.infoCalls, 1);
                assert.equal(native.state.calls.length, 0);
            }
        );

        await t.test(
            'legacy revision22 profile/configure/search explicitly refuse TEI before claim, query embedding or native metadata',
            async () => {
                const before = {
                    info: native.state.infoCalls,
                    post: native.state.calls.length,
                    embeds: fixture.state.embedCalls,
                    claims: await prisma.rerankRequest.count({
                        where: { organizationId: f.org },
                    }),
                };
                await assert.rejects(
                    f.owner.rag.reranking.profile({ collectionId }),
                    failure('PROFILE_UNSUPPORTED')
                );
                await assert.rejects(
                    f.owner.rag.reranking.configure({
                        collectionId,
                        expectedRevision: revision,
                        enabled: false,
                        provider: 'COHERE',
                        model: 'rerank-v5.0-fast',
                        candidatePool: 32,
                    }),
                    failure('PROFILE_UNSUPPORTED')
                );
                await assert.rejects(
                    f.owner.rag.reranking.search(search()),
                    failure('PROFILE_UNSUPPORTED')
                );
                assert.deepEqual(
                    {
                        info: native.state.infoCalls,
                        post: native.state.calls.length,
                        embeds: fixture.state.embedCalls,
                        claims: await prisma.rerankRequest.count({
                            where: { organizationId: f.org },
                        }),
                    },
                    before
                );
            }
        );

        let endpoint = await f.owner.rag.reranking.endpoints.create({
            name: 'Native TEI primary',
            provider: 'TEI',
            endpoint: native.endpoint,
            apiKey: null,
            activate: false,
        });
        const secondary = await f.owner.rag.reranking.endpoints.create({
            name: 'Native TEI alternate',
            provider: 'TEI',
            endpoint: alternate.endpoint,
            apiKey: null,
            activate: false,
        });
        await t.test(
            'separate endpoint inventory masks/encrypts optional keys and invalid organization selection never falls back',
            async () => {
                assert.equal(endpoint.apiKey, null);
                assert.deepEqual(
                    (
                        await f.owner.rag.credentials.list({
                            query: '',
                            offset: 0,
                            limit: 100,
                        })
                    ).items.map((row) => row.id),
                    oldCredentials.items.map((row) => row.id)
                );
                assert.equal(
                    (
                        await f.other.rag.reranking.endpoints.list({
                            query: '',
                            offset: 0,
                            limit: 100,
                        })
                    ).total,
                    0
                );
                const before = native.state.infoCalls;
                await assert.rejects(
                    configure(),
                    failure('CREDENTIALS_INVALID')
                );
                assert.equal(native.state.infoCalls, before);
                endpoint = await f.owner.rag.reranking.endpoints.update({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                    name: endpoint.name,
                    endpoint: endpoint.endpoint,
                    apiKey: 'tei-temporary-native-key',
                });
                assert.equal(endpoint.apiKey, '********');
                const encrypted =
                    await prisma.rerankEndpointCredential.findUniqueOrThrow({
                        where: { id: endpoint.id },
                    });
                assert(
                    encrypted.apiKey &&
                        !encrypted.apiKey.includes('tei-temporary-native-key')
                );
                endpoint = await f.owner.rag.reranking.endpoints.update({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                    name: endpoint.name,
                    endpoint: endpoint.endpoint,
                });
                assert.equal(
                    (
                        await prisma.rerankEndpointCredential.findUniqueOrThrow(
                            { where: { id: endpoint.id } }
                        )
                    ).apiKey,
                    encrypted.apiKey
                );
                endpoint = await f.owner.rag.reranking.endpoints.update({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                    name: endpoint.name,
                    endpoint: endpoint.endpoint,
                    apiKey: null,
                });
                assert.equal(endpoint.apiKey, null);
                assert.equal(
                    (
                        await prisma.rerankEndpointCredential.findUniqueOrThrow(
                            { where: { id: endpoint.id } }
                        )
                    ).apiKey,
                    null
                );
                await assert.rejects(
                    f.other.rag.reranking.endpoints.update({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                        name: 'Foreign rename',
                        endpoint: endpoint.endpoint,
                    })
                );
                await assert.rejects(
                    f.other.rag.reranking.endpoints.remove({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                    })
                );
                assert.equal(
                    (
                        await prisma.rerankEndpointCredential.findUniqueOrThrow(
                            { where: { id: endpoint.id } }
                        )
                    ).name,
                    endpoint.name
                );
                assert.equal(native.state.infoCalls, before);
                assert.equal(native.state.calls.length, 0);
                await f.owner.rag.reranking.endpoints.activate({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                });
                const configured = await configure();
                assert.equal(
                    configured.configuration?.bindingSource,
                    'ORGANIZATION'
                );
                assert.equal(
                    configured.configuration?.runtimeSnapshot?.protocolVersion,
                    'native-tei-v1'
                );
                assert.equal(native.state.infoCalls, before + 1);
                assert.equal(native.state.calls.length, 0);
            }
        );

        await t.test(
            'one TEI operation ranks only the captured children, preserves parent/source receipts and reports unknown billing',
            async () => {
                const before = {
                    info: native.state.infoCalls,
                    post: native.state.calls.length,
                    embed: fixture.state.embedCalls,
                };
                const result =
                    await f.owner.rag.reranking.extended.search(search());
                assert.equal(native.state.infoCalls, before.info + 1);
                assert.equal(native.state.calls.length, before.post + 1);
                assert.equal(fixture.state.embedCalls, before.embed + 1);
                assert.equal(result.generationId, started.generationId);
                assert.equal(result.reranking.provider, 'TEI');
                assert.equal(
                    result.reranking.scoreKind,
                    'normalized_cross_encoder'
                );
                assert.equal(result.reranking.candidateCount, children.length);
                assert.equal(result.reranking.rerankedCount, children.length);
                assert.deepEqual(result.reranking.usage, {
                    providerInputTokens: 23,
                    billedInputTokens: null,
                    billedSearchUnits: null,
                });
                assert(
                    result.comparison && result.comparison.results.length > 0
                );
                assert.equal(
                    result.comparison.results[0]?.documentId,
                    first.id
                );
                assert.equal(result.results[0]?.documentId, target.id);
                assert(
                    native.state.calls
                        .at(-1)!
                        .texts.every((text) => childTexts.has(text))
                );
                for (const rows of [
                    result.results,
                    result.comparison.results,
                ]) {
                    assert.equal(
                        new Set(rows.map((row) => row.parentContext?.id)).size,
                        rows.length
                    );
                    assert(
                        rows.every(
                            (row) =>
                                row.parentContext &&
                                row.sourceSpans.length <= 64 &&
                                row.parentContext.sourceSpans.length <= 64
                        )
                    );
                }
                for (const row of result.results) {
                    const baseline: SearchResult | undefined =
                        result.comparison.results.find(
                            (other) => other.id === row.id
                        );
                    if (baseline) {
                        assert.deepEqual(row.scores, baseline.scores);
                        assert.deepEqual(row.source, baseline.source);
                    }
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
                const legacy = await f.owner.rag.reranking.usage({});
                assert.deepEqual(legacy.usage, []);
                const extended = await f.owner.rag.reranking.extended.usage({});
                const usage = extended.usage.find(
                    (row) => row.provider === 'TEI'
                );
                assert(usage);
                assert.equal(usage.validatedRequests, '1');
                assert.equal(usage.knownProviderInputTokens, '23');
                assert.equal(usage.unknownBilledInputTokenRequests, '1');
            }
        );

        await t.test(
            'TEI per-child concurrency bounds reject pool8 at four permits while an explicit pool4 succeeds',
            async () => {
                native.state.maxConcurrentRequests = 4;
                const post = native.state.calls.length;
                try {
                    await assert.rejects(
                        configure({ candidatePool: 8 }),
                        failure('INPUT_TOO_LARGE')
                    );
                    assert.equal(native.state.calls.length, post);
                    const debits = await dispatches();
                    await assert.rejects(
                        f.owner.rag.reranking.extended.search(search()),
                        failure('INPUT_TOO_LARGE')
                    );
                    assert.equal(native.state.calls.length, post);
                    assert.equal(await dispatches(), debits);
                    await configure({ candidatePool: 4 });
                    const result =
                        await f.owner.rag.reranking.extended.search(search());
                    assert.equal(result.reranking.candidateLimit, 4);
                    assert.equal(native.state.calls.length, post + 1);
                    assert.equal(native.state.calls.at(-1)?.texts.length, 4);
                } finally {
                    native.state.maxConcurrentRequests = 32;
                }
                await configure({ candidatePool: 32 });
            }
        );

        await t.test(
            'activation does not retarget a retained binding; key rotation works but referenced move/removal conflicts',
            async () => {
                await f.owner.rag.reranking.endpoints.activate({
                    id: secondary.id,
                    expectedRevision: secondary.revision,
                });
                endpoint = await f.owner.rag.reranking.endpoints.update({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                    name: endpoint.name,
                    endpoint: endpoint.endpoint,
                    apiKey: 'tei-rotated-native-key',
                });
                native.state.apiKey = 'tei-rotated-native-key';
                const before = {
                    main: native.state.calls.length,
                    other: alternate.state.calls.length,
                };
                native.state.tokens = null;
                const result =
                    await f.owner.rag.reranking.extended.search(search());
                assert.equal(native.state.calls.length, before.main + 1);
                assert.equal(alternate.state.calls.length, before.other);
                assert.deepEqual(result.reranking.usage, {
                    providerInputTokens: null,
                    billedInputTokens: null,
                    billedSearchUnits: null,
                });
                native.state.tokens = 23;
                await assert.rejects(
                    f.owner.rag.reranking.endpoints.update({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                        name: endpoint.name,
                        endpoint: alternate.endpoint,
                        apiKey: null,
                    }),
                    { code: 'CONFLICT' }
                );
                await assert.rejects(
                    f.owner.rag.reranking.endpoints.remove({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                    }),
                    { code: 'CONFLICT' }
                );
                await f.owner.rag.reranking.endpoints.activate({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                });
            }
        );

        await t.test(
            'generic key retirement rewrites the real TEI encrypted column without changing business revision or timestamps',
            async () => {
                const previousKeys = process.env.ENCRYPTION_PREVIOUS_SECRETS;
                const retiredHex = 'd'.repeat(64);
                assert(process.env.ENCRYPTION_SECRET !== retiredHex);
                const before =
                    await prisma.rerankEndpointCredential.findUniqueOrThrow({
                        where: { id: endpoint.id },
                    });
                const context = rerankEndpointSecretContext(f.org, endpoint.id);
                const plaintext = 'tei-rotated-native-key';
                assert(before.apiKey);
                assert.equal(decrypt(before.apiKey, context), plaintext);
                const key = Buffer.from(retiredHex, 'hex');
                const iv = randomBytes(16);
                const cipher = createCipheriv('aes-256-gcm', key, iv, {
                    authTagLength: 16,
                });
                cipher.setAAD(Buffer.from(context, 'utf8'));
                const data = Buffer.concat([
                    cipher.update(plaintext, 'utf8'),
                    cipher.final(),
                ]).toString('hex');
                const keyId = createHash('sha256')
                    .update(key)
                    .digest('hex')
                    .slice(0, 16);
                const retired = `v2:${keyId}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
                try {
                    await prisma.rerankEndpointCredential.update({
                        where: { id: endpoint.id },
                        data: { apiKey: retired, updatedAt: before.updatedAt },
                    });
                    process.env.ENCRYPTION_PREVIOUS_SECRETS = [
                        previousKeys,
                        retiredHex,
                    ]
                        .filter(Boolean)
                        .join(',');
                    assert.equal(decrypt(retired, context), plaintext);
                    assert.equal(needsReencryption(retired), true);
                    const column = encryptedColumns(prisma).find(
                        (entry) => entry.name === 'rerankEndpointCredential'
                    );
                    assert(column);
                    const report = await reencryptSecretColumns([column], {
                        batchSize: 1,
                    });
                    assert.equal(report.status, 'COMPLETE');
                    assert.equal(
                        report.columns.rerankEndpointCredential?.reencrypted,
                        1
                    );
                    assert.equal(
                        report.columns.rerankEndpointCredential?.remaining,
                        0
                    );
                    const after =
                        await prisma.rerankEndpointCredential.findUniqueOrThrow(
                            { where: { id: endpoint.id } }
                        );
                    assert(after.apiKey);
                    assert.notEqual(after.apiKey, retired);
                    assert.equal(decrypt(after.apiKey, context), plaintext);
                    assert.equal(needsReencryption(after.apiKey), false);
                    assert.equal(after.revision, before.revision);
                    assert.deepEqual(after.updatedAt, before.updatedAt);
                    assert.equal(after.endpoint, before.endpoint);
                    assert.equal(after.active, before.active);
                } finally {
                    if (previousKeys === undefined)
                        delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
                    else process.env.ENCRYPTION_PREVIOUS_SECRETS = previousKeys;
                }
                const post = native.state.calls.length;
                assert(
                    (await f.owner.rag.reranking.extended.search(search()))
                        .results.length > 0
                );
                assert.equal(native.state.calls.length, post + 1);
            }
        );

        await t.test(
            'current role, issuer and collection scope precede endpoint management and TEI content I/O',
            async () => {
                const member = await prisma.member.findUniqueOrThrow({
                    where: { id: memberId },
                });
                previousRole = member.role;
                const role = await prisma.organizationRole.create({
                    data: {
                        id: randomUUID(),
                        organizationId: f.org,
                        role: `tei-reader-${randomUUID()}`,
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
                const key =
                    await f.reader.client.admin.organization.apiKeys.create({
                        name: 'Scoped native TEI reader',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                            ragRerank: ['use'],
                        },
                        collectionScopes: [
                            {
                                collectionId,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                scopedApi = rpc(() => ({ 'x-api-key': key.key })).admin.rag;
                // Native key issuance deliberately excludes credential management.
                // Exercise that refusal, then use the real read/rerank key to
                // verify fail-closed endpoint routes; their session guard remains
                // defense in depth, not permission delegated to a fabricated key.
                await assert.rejects(
                    f.owner.client.admin.organization.apiKeys.create({
                        name: 'Nondelegable endpoint management refusal',
                        permissions: { ragCredentials: ['read', 'manage'] },
                        collectionScopes: [],
                    }),
                    { code: 'BAD_REQUEST' }
                );
                const before = {
                    info: native.state.infoCalls,
                    post: native.state.calls.length,
                };
                await assert.rejects(
                    scopedApi.reranking.endpoints.list({
                        query: '',
                        offset: 0,
                        limit: 10,
                    })
                );
                await assert.rejects(
                    scopedApi.reranking.endpoints.create({
                        name: 'Sessionless endpoint',
                        provider: 'TEI',
                        endpoint: native.endpoint,
                        apiKey: null,
                        activate: false,
                    })
                );
                await assert.rejects(
                    scopedApi.reranking.endpoints.update({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                        name: endpoint.name,
                        endpoint: endpoint.endpoint,
                    })
                );
                await assert.rejects(
                    scopedApi.reranking.endpoints.activate({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                    })
                );
                await assert.rejects(
                    scopedApi.reranking.endpoints.remove({
                        id: endpoint.id,
                        expectedRevision: endpoint.revision,
                    })
                );
                await assert.rejects(
                    f.reader.rag.reranking.extended.configure({
                        collectionId,
                        expectedRevision: revision,
                        enabled: true,
                        provider: 'TEI',
                        model: teiModel,
                        candidatePool: 32,
                    })
                );
                await assert.rejects(
                    f.other.rag.reranking.extended.search(search())
                );
                const foreign = await fixture.collection(
                    'TEI unscoped collection'
                );
                await assert.rejects(
                    scopedApi.reranking.extended.search(
                        search({ collectionId: foreign.id })
                    )
                );
                assert.deepEqual(
                    {
                        info: native.state.infoCalls,
                        post: native.state.calls.length,
                    },
                    before
                );
                assert(
                    (await scopedApi.reranking.extended.search(search()))
                        .results.length > 0
                );
            }
        );

        await t.test(
            'runtime drift, endpoint rejection and invalid query/pool refuse without a TEI POST or retry',
            async () => {
                const before = native.state.calls.length;
                native.state.revision = 'b'.repeat(40);
                const drift = search();
                const debits = await dispatches();
                try {
                    await assert.rejects(
                        f.owner.rag.reranking.extended.search(drift),
                        failure('MODEL_CHANGED')
                    );
                } finally {
                    native.state.revision = 'a'.repeat(40);
                }
                assert.equal(native.state.calls.length, before);
                assert.equal(await dispatches(), debits);
                const refused = await prisma.rerankRequest.findFirstOrThrow({
                    where: {
                        organizationId: f.org,
                        requestId: drift.requestId,
                    },
                });
                assert.equal(refused.state, 'SKIPPED');
                assert.equal(refused.dispatchedAt, null);
                process.env.VECTORIX_DEFAULT_TEI_ENDPOINT = alternate.endpoint;
                process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS =
                    alternate.endpoint;
                const infos = native.state.infoCalls;
                try {
                    await assert.rejects(
                        configure(),
                        failure('CREDENTIALS_INVALID')
                    );
                } finally {
                    process.env.VECTORIX_DEFAULT_TEI_ENDPOINT = native.endpoint;
                    process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS = `${native.endpoint},${alternate.endpoint}`;
                }
                assert.equal(native.state.infoCalls, infos);
                await assert.rejects(
                    configure({ candidatePool: 33 }),
                    failure('INPUT_TOO_LARGE')
                );
                await assert.rejects(
                    configure({
                        provider: 'FUTURE_ENGINE',
                        model: 'operator/model',
                    }),
                    failure('MODEL_UNSUPPORTED')
                );
                const embeds = fixture.state.embedCalls;
                await assert.rejects(
                    f.owner.rag.reranking.extended.search(
                        search({ query: 'é'.repeat(2100) })
                    ),
                    failure('INPUT_TOO_LARGE')
                );
                assert.equal(fixture.state.embedCalls, embeds);
                assert.equal(native.state.calls.length, before);
                const replay = search();
                await f.owner.rag.reranking.extended.search(replay);
                const post = native.state.calls.length;
                const get = native.state.infoCalls;
                await assert.rejects(
                    f.owner.rag.reranking.extended.search(replay),
                    failure('RERANK_REQUEST_REPLAY')
                );
                assert.equal(native.state.calls.length, post);
                assert.equal(native.state.infoCalls, get);
            }
        );

        await t.test(
            'issuer revocation while live metadata is delayed refuses before inference admission',
            async () => {
                assert(scopedApi && roleId);
                const latch = semanticLatch();
                native.state.beforeInfo = latch.block;
                const request = search();
                const before = {
                    post: native.state.calls.length,
                    debits: await dispatches(),
                };
                const pending = scopedApi.reranking.extended
                    .search(request)
                    .then(
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
                    delete native.state.beforeInfo;
                    latch.release();
                }
                try {
                    assert(failure('ACCESS_REVOKED')(await pending));
                    const row = await prisma.rerankRequest.findFirstOrThrow({
                        where: {
                            organizationId: f.org,
                            requestId: request.requestId,
                        },
                    });
                    assert.equal(row.state, 'SKIPPED');
                    assert.equal(row.dispatchedAt, null);
                    assert.equal(native.state.calls.length, before.post);
                    assert.equal(await dispatches(), before.debits);
                } finally {
                    await prisma.organizationRole.update({
                        where: { id: roleId },
                        data: { permission: JSON.stringify(readerPermissions) },
                    });
                }
            }
        );

        await t.test(
            'disabling the profile during live metadata refuses before inference and re-enabling remains explicit',
            async () => {
                const latch = semanticLatch();
                native.state.beforeInfo = latch.block;
                const request = search();
                const before = {
                    post: native.state.calls.length,
                    debits: await dispatches(),
                };
                const pending = f.owner.rag.reranking.extended
                    .search(request)
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await latch.arrived();
                    await configure({ enabled: false });
                } finally {
                    delete native.state.beforeInfo;
                    latch.release();
                }
                assert(failure('RERANK_DISABLED')(await pending));
                assert.equal(native.state.calls.length, before.post);
                assert.equal(await dispatches(), before.debits);
                const row = await prisma.rerankRequest.findFirstOrThrow({
                    where: {
                        organizationId: f.org,
                        requestId: request.requestId,
                    },
                });
                assert.equal(row.dispatchedAt, null);
                await configure();
            }
        );

        await t.test(
            'overlapping explicit metadata saves have one CAS winner without duplicated inference',
            async () => {
                const before = native.state.infoCalls;
                const latch = semanticLatch();
                native.state.beforeInfo = latch.block;
                native.state.model = '/data/custom/model:v2@revision';
                const save = {
                    collectionId,
                    expectedRevision: revision,
                    enabled: true,
                    provider: 'TEI',
                    model: native.state.model,
                    candidatePool: 32,
                };
                const saves = Promise.allSettled([
                    f.owner.rag.reranking.extended.configure(save),
                    f.owner.rag.reranking.extended.configure(save),
                ]);
                try {
                    await latch.arrived();
                    for (
                        let pass = 0;
                        pass < 100 && native.state.infoCalls < before + 2;
                        pass++
                    )
                        await setTimeout(10);
                    assert.equal(native.state.infoCalls, before + 2);
                } finally {
                    delete native.state.beforeInfo;
                    latch.release();
                }
                const results = await saves;
                assert.equal(
                    results.filter((result) => result.status === 'fulfilled')
                        .length,
                    1
                );
                const winner = results.find(
                    (result) => result.status === 'fulfilled'
                );
                assert(winner && winner.status === 'fulfilled');
                revision = winner.value.revision;
                model = native.state.model;
                assert.equal(winner.value.configuration?.model, model);
                assert.equal(
                    winner.value.configuration?.runtimeSnapshot?.modelId,
                    model
                );
                const loser = results.find(
                    (result) => result.status === 'rejected'
                );
                assert(loser && loser.status === 'rejected');
                assert(failure('RERANK_PROFILE_CHANGED')(loser.reason));
            }
        );

        await t.test(
            'endpoint deletion during metadata I/O cannot save a stale binding',
            async () => {
                const fresh = await fixture.collection(
                    'TEI deletion during explicit save'
                );
                const ephemeral = await f.owner.rag.reranking.endpoints.create({
                    name: 'Ephemeral native TEI',
                    provider: 'TEI',
                    endpoint: native.endpoint,
                    apiKey: 'tei-rotated-native-key',
                    activate: true,
                });
                const latch = semanticLatch();
                native.state.beforeInfo = latch.block;
                const save = f.owner.rag.reranking.extended
                    .configure({
                        collectionId: fresh.id,
                        expectedRevision: 0,
                        enabled: true,
                        provider: 'TEI',
                        model,
                        candidatePool: 32,
                    })
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await latch.arrived();
                    await f.owner.rag.reranking.endpoints.remove({
                        id: ephemeral.id,
                        expectedRevision: ephemeral.revision,
                    });
                } finally {
                    delete native.state.beforeInfo;
                    latch.release();
                }
                assert(failure('CREDENTIALS_INVALID')(await save));
                assert.equal(
                    (
                        await f.owner.rag.reranking.extended.profile({
                            collectionId: fresh.id,
                        })
                    ).revision,
                    0
                );
                await f.owner.rag.reranking.endpoints.activate({
                    id: endpoint.id,
                    expectedRevision: endpoint.revision,
                });
            }
        );

        await t.test(
            'revocation during native TEI POST settles validated usage but denies results and future issuer calls',
            async () => {
                assert(scopedApi && roleId);
                const latch = semanticLatch();
                native.state.beforeReply = latch.block;
                const request = search();
                const pending = scopedApi.reranking.extended
                    .search(request)
                    .then(
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
                    assert(failure('ACCESS_REVOKED')(await pending));
                    const row = await prisma.rerankRequest.findFirstOrThrow({
                        where: {
                            organizationId: f.org,
                            requestId: request.requestId,
                        },
                    });
                    assert.equal(row.state, 'VALIDATED');
                    assert.equal(row.providerInputTokens, 23n);
                    assert.equal(row.billedInputTokens, null);
                    assert.equal(row.billedSearchUnits, null);
                    const before = {
                        info: native.state.infoCalls,
                        post: native.state.calls.length,
                    };
                    await assert.rejects(
                        scopedApi.reranking.extended.search(search())
                    );
                    assert(
                        (
                            await scopedApi.indexing.search({
                                collectionId,
                                query: 'Shared question',
                                strategy: 'VECTOR',
                                topK: 1,
                                filters: {},
                            })
                        ).results.length > 0
                    );
                    assert.deepEqual(
                        {
                            info: native.state.infoCalls,
                            post: native.state.calls.length,
                        },
                        before
                    );
                } finally {
                    await prisma.organizationRole.update({
                        where: { id: roleId },
                        data: { permission: JSON.stringify(readerPermissions) },
                    });
                }
            }
        );

        await t.test(
            'a source detached during live metadata cannot be sent to TEI or acquire dispatch intent',
            async () => {
                const latch = semanticLatch();
                native.state.beforeInfo = latch.block;
                const request = search();
                const before = {
                    post: native.state.calls.length,
                    debits: await dispatches(),
                };
                const pending = f.owner.rag.reranking.extended
                    .search(request)
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await latch.arrived();
                    await f.owner.rag.documents.setCollection({
                        id: target.id,
                        collectionId,
                        attached: false,
                    });
                } finally {
                    delete native.state.beforeInfo;
                    latch.release();
                }
                assert(failure('SOURCE_UNAVAILABLE')(await pending));
                assert.equal(native.state.calls.length, before.post);
                assert.equal(await dispatches(), before.debits);
                const row = await prisma.rerankRequest.findFirstOrThrow({
                    where: {
                        organizationId: f.org,
                        requestId: request.requestId,
                    },
                });
                assert.equal(row.state, 'SKIPPED');
                assert.equal(row.dispatchedAt, null);
                const calls = {
                    info: native.state.infoCalls,
                    post: native.state.calls.length,
                };
                await configure({ enabled: false });
                await assert.rejects(
                    f.owner.rag.reranking.extended.search(search()),
                    failure('RERANK_DISABLED')
                );
                assert.deepEqual(
                    {
                        info: native.state.infoCalls,
                        post: native.state.calls.length,
                    },
                    calls
                );
                assert.equal(
                    (await f.owner.rag.indexing.status({ collectionId })).active
                        ?.id,
                    started.generationId
                );
            }
        );
    } finally {
        try {
            if (previousRole !== undefined)
                await prisma.member.update({
                    where: { id: memberId },
                    data: { role: previousRole },
                });
        } finally {
            for (const name of variables) {
                const value = previous[name];
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            try {
                await native.close();
            } finally {
                try {
                    await alternate.close();
                } finally {
                    await fixture.close();
                }
            }
        }
    }
}
