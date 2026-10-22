import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import {
    chunkView,
    indexGeneration,
    parentContext,
    searchResult,
} from '@repo/api-contracts/v1/rag/indexing-types';
import { app } from '../app';
import { fixture as f, profile } from './fixtures';

export async function lifecycleTests(t: TestContext) {
    await t.test(
        'optional parent context preserves historical chunk and generation DTOs and bounds new context',
        () => {
            const span = {
                source: { kind: 'text' as const, index: 0, start: 0, end: 20 },
                start: 2,
                end: 9,
            };
            const child = {
                id: 'contract-child',
                generationId: 'contract-generation',
                publicationId: 'contract-publication',
                documentId: 'contract-document',
                documentName: 'Contract document',
                version: 1,
                ordinal: 0,
                text: 'passage',
                tokenCount: 3,
                tokenCountIsEstimate: true,
                language: 'EN' as const,
                sourceSpans: [span],
                sourceSpansTruncated: false,
                published: true,
            };
            assert.deepEqual(chunkView.parse(child), child);
            assert.equal(
                chunkView.parse({
                    ...child,
                    startOffset: null,
                    endOffset: null,
                }).startOffset,
                null
            );
            const parent = {
                id: 'contract-parent',
                ordinal: 1,
                text: 'A passage in context',
                startOffset: 0,
                endOffset: 20,
                tokenCount: 7,
                tokenCountIsEstimate: true,
                sourceSpans: [span],
                sourceSpansTruncated: false,
            };
            const extended = {
                ...child,
                startOffset: 2,
                endOffset: 9,
                parentContext: parent,
            };
            assert.deepEqual(chunkView.parse(extended), extended);
            assert.deepEqual(
                chunkView
                    .omit({
                        parentContext: true,
                        startOffset: true,
                        endOffset: true,
                    })
                    .parse(extended),
                child
            );
            assert.equal(
                parentContext.safeParse({
                    ...parent,
                    startOffset: 20,
                    endOffset: 20,
                }).success,
                false
            );
            assert.equal(
                parentContext.safeParse({
                    ...parent,
                    sourceSpans: Array.from({ length: 65 }, () => span),
                }).success,
                false
            );
            const source = {
                receipt: 'same-child-receipt',
                expiresAt: new Date(),
            };
            const result = searchResult.parse({
                ...extended,
                mediaType: 'text/plain',
                tags: [],
                metadata: {},
                source,
                scores: {
                    rrf: 1 / 61,
                    lexicalRank: 1,
                    vectorRank: null,
                    vectorDistance: null,
                },
            });
            assert.equal(result.id, child.id);
            assert.equal(result.text, child.text);
            assert.deepEqual(result.source, source);
            const generation = {
                id: 'contract-generation',
                status: 'ACTIVE' as const,
                configurationRevision: 1,
                previousGenerationId: null,
                model: 'synthetic-model',
                dimensions: 128,
                modelIdentity: 'synthetic-identity',
                createdAt: new Date(),
                activatedAt: new Date(),
                retiredAt: null,
                cleanupAfter: null,
                projectedChunks: 1,
                totalDocuments: 1,
                publishedDocuments: 1,
                errorCode: null,
            };
            assert.deepEqual(indexGeneration.parse(generation), generation);
            assert.equal(
                indexGeneration.parse({
                    ...generation,
                    parentContextVersion: null,
                }).parentContextVersion,
                null
            );
            assert.deepEqual(
                indexGeneration.omit({ parentContextVersion: true }).parse({
                    ...generation,
                    parentContextVersion: 'parent-context-utf8-v1',
                }),
                generation
            );
        }
    );
    await t.test(
        'configuration revisions are immutable, optimistic, bounded, and have no private fields',
        async () => {
            const collection = await f.owner.rag.collections.create({
                name: 'Profile versions',
                profile,
                grantCreatorRead: false,
            });
            assert.equal(collection.permissions.read, false);
            const original =
                await prisma.collectionConfigRevision.findUniqueOrThrow({
                    where: {
                        ['organizationId_collectionId_revision']: {
                            organizationId: f.org,
                            collectionId: collection.id,
                            revision: 1,
                        },
                    },
                });
            const update = {
                id: collection.id,
                expectedRevision: 1,
                name: 'Profile versions 2',
                description: 'Updated',
                profile: { ...profile, dimensions: 1024, parentChild: true },
            };
            assert.equal(
                (await f.owner.rag.collections.update(update))
                    .configurationRevision,
                2
            );
            await assert.rejects(f.owner.rag.collections.update(update), {
                code: 'CONFLICT',
            });
            assert.deepEqual(
                await prisma.collectionConfigRevision.findUniqueOrThrow({
                    where: { id: original.id },
                }),
                original
            );
            const result = await f.owner.rag.collections.get({
                id: collection.id,
            });
            assert.equal(result.configuration.parentChild, true);
            assert.equal(result.configuration.dimensions, 1024);
            assert.equal(
                (
                    await f.owner.rag.indexing.status({
                        collectionId: collection.id,
                    })
                ).unsupportedReason,
                null,
                'Parent mode is executable; model availability is established separately by native verification.'
            );
            assert.ok(!('endpoint' in result.configuration));
            assert.ok(!('organizationId' in result.configuration));
            assert.ok(!('apiKey' in result.configuration));
            await assert.rejects(
                f.owner.rag.collections.create({
                    name: 'Invalid HNSW',
                    profile: {
                        ...profile,
                        dimensions: 3000,
                        indexType: 'HNSW',
                    },
                }),
                { code: 'BAD_REQUEST' }
            );
            await assert.rejects(
                f.owner.rag.collections.create({
                    name: 'Invalid chunks',
                    profile: {
                        ...profile,
                        chunking: { targetTokens: 128, overlapTokens: 128 },
                    },
                }),
                { code: 'BAD_REQUEST' }
            );
            await assert.rejects(f.owner.rag.collections.list({ limit: 101 }), {
                code: 'BAD_REQUEST',
            });
        }
    );

    await t.test(
        'concurrent creation respects quotas with no partial writes or audit on rollback',
        async () => {
            const current = await f.owner.rag.quota({});
            const limits = {
                ...current.limits,
                collections: current.usage.collections + 1,
            };
            await assert.rejects(
                f.owner.client.superadmin.organizations.setRagQuota({
                    organizationId: f.org,
                    limits,
                }),
                { code: 'FORBIDDEN' }
            );
            await prisma.user.update({
                where: { id: f.users[0] },
                data: { isSuperAdmin: true },
            });
            await f.owner.client.superadmin.organizations.setRagQuota({
                organizationId: f.org,
                limits,
            });
            const effective =
                await f.owner.client.superadmin.organizations.getRagQuota({
                    organizationId: f.org,
                });
            assert.deepEqual(effective, { limits, overridden: true });
            const before = await prisma.ragAuditLog.count({
                where: { organizationId: f.org, action: 'collection.create' },
            });
            const results = await Promise.allSettled(
                [0, 1].map((i) =>
                    f.owner.rag.collections.create({
                        name: `Last quota slot ${i}`,
                        profile,
                    })
                )
            );
            assert.equal(
                results.filter((r) => r.status === 'fulfilled').length,
                1
            );
            const failure = results.find((r) => r.status === 'rejected');
            assert.ok(failure?.status === 'rejected');
            assert.equal(failure.reason.code, 'CONFLICT');
            assert.equal(
                (await f.owner.rag.quota({})).usage.collections,
                limits.collections
            );
            assert.equal(
                await prisma.ragAuditLog.count({
                    where: {
                        organizationId: f.org,
                        action: 'collection.create',
                    },
                }),
                before + 1
            );
            const records = await f.owner.rag.audit({ query: 'quota.update' });
            assert.equal(records.total, 1);
            assert.equal(records.items[0]?.actorId, f.users[0]);
            assert.equal(
                (await f.other.rag.audit({ query: 'quota.update' })).total,
                0
            );
            assert.equal((await f.other.rag.quota({})).limits.collections, 20);
        }
    );

    await t.test(
        'retained originals and extracted contents count independently of vectors',
        async () => {
            const location = await prisma.storageLocation.findFirstOrThrow({
                where: { organizationId: f.org },
            });
            const doc = await prisma.document.create({
                data: {
                    organizationId: f.org,
                    name: 'Stored fixture',
                    deletedAt: new Date(),
                },
            });
            const version = await prisma.documentVersion.create({
                data: {
                    organizationId: f.org,
                    documentId: doc.id,
                    version: 1,
                    storageLocationId: location.id,
                    objectKey: 'original-fixture',
                    sha256: 'a'.repeat(64),
                    byteSize: 1024n,
                    mediaType: 'text/plain',
                },
            });
            await prisma.documentExtraction.create({
                data: {
                    organizationId: f.org,
                    versionId: version.id,
                    storageLocationId: location.id,
                    objectKey: 'text-fixture',
                    byteSize: 512n,
                    extractorVersion: 'test',
                    language: 'en',
                },
            });
            assert.equal(
                (await f.owner.rag.quota({})).usage.storageBytes,
                1536
            );
            await assert.rejects(f.owner.rag.documents.get({ id: doc.id }), {
                code: 'NOT_FOUND',
            });
            await assert.rejects(
                prisma.storageLocation.delete({ where: { id: location.id } }),
                { code: 'P2003' }
            );
        }
    );

    await t.test(
        'RPC, REST, OpenAPI aliases, and version discovery expose the same compatible revision',
        async () => {
            const response = await app.request(
                'http://localhost:3001/api/v1/admin/rag/collections',
                { headers: f.owner.headers() }
            );
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('Vectorix-API-Revision'), '18');
            assert.equal(
                (await response.json()).total,
                (await f.owner.rag.collections.list({})).total
            );
            const spec = await (await app.request('/spec/v1.json')).json();
            const alias = await (await app.request('/spec.json')).json();
            assert.equal(spec.info.version, '1.18.0');
            assert.deepEqual(alias, spec);
            for (const provider of ['OPENAI', 'MISTRAL'])
                assert.ok(
                    JSON.stringify(spec).includes(JSON.stringify(provider))
                );
            assert.ok(spec.paths['/admin/rag/credentials'].post);
            assert.ok(spec.paths['/admin/rag/collections/{id}/revisions'].get);
            assert.ok(
                spec.paths['/admin/rag/collections/{id}/grant-candidates'].get
            );
            assert.ok(
                spec.paths['/admin/rag/groups/{id}/member-candidates'].get
            );
            assert.ok(
                spec.paths[
                    '/superadmin/organizations/{organizationId}/rag-quota'
                ].get
            );
            assert.ok(spec.paths['/admin/rag/collections/{id}/grants'].put);
            assert.ok(
                spec.paths['/admin/rag/documents/{id}/replacements'].post
            );
            assert.ok(spec.paths['/admin/rag/documents/{id}'].delete);
            assert.ok(spec.paths['/admin/rag/documents/deleted'].get);
            assert.ok(spec.paths['/admin/rag/documents/{id}/lifecycle'].get);
            const discovery = await (
                await app.request('/api-versions.json')
            ).json();
            assert.ok(JSON.stringify(discovery).includes('"revision":18'));
            assert.equal(
                (await app.request('/api/v1/admin/rag/collections')).status,
                401
            );
        }
    );
}
