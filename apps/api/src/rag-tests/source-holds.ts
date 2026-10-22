import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { prisma } from '@repo/db';
import { auth } from '@repo/auth';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import {
    acquireSourceHold,
    releaseSourceHold,
    renewSourceHold,
    retireSourceHold,
} from '@routers/rag/source-holds';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { app } from '../app';
import { fixture as f } from './fixtures';

/** Real durable holds serialize with destructive S3 authorization, never merely with task completion. */
export async function sourceHoldTests(t: TestContext) {
    const endpoint = process.env.VECTORIX_DEFAULT_S3_ENDPOINT!;
    const data = {
        provider: 'S3' as const,
        endpoint,
        bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET!,
        region: 'us-east-1',
        forcePathStyle: true,
        accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
    };
    const s3 = new S3Client({
        ...data,
        credentials: {
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
        },
    });
    const storage = await f.owner.rag.credentials.create({
        name: `Hold storage ${randomUUID()}`,
        data,
    });
    await f.owner.rag.credentials.activate({ id: storage.id });
    const identity = (indexedDocumentId: string) => ({
        organizationId: f.org,
        indexedDocumentId,
    });
    async function generation(organizationId: string) {
        const collection = await prisma.collection.create({
            data: { organizationId, name: 'Source hold fixture' },
        });
        const connection = await prisma.vectorConnection.create({
            data: {
                organizationId,
                key: randomUUID(),
                schema: 'vector_collections',
            },
        });
        await prisma.collectionConfigRevision.create({
            data: {
                organizationId,
                collectionId: collection.id,
                revision: 1,
                vectorConnectionId: connection.id,
                provider: 'OLLAMA',
                model: 'hold-fixture',
                dimensions: 3,
                endpoint: 'http://127.0.0.1:11434',
                chunking: {},
            },
        });
        const generationId = randomUUID();
        return prisma.indexGeneration.create({
            data: {
                id: generationId,
                organizationId,
                collectionId: collection.id,
                requestId: randomUUID(),
                configurationRevision: 1,
                vectorConnectionId: connection.id,
                vectorSchema: connection.schema,
                tableName: `g_${generationId.replaceAll('-', '')}`,
                destinationFingerprint: 'isolated-test-only',
                modelIdentity: 'hold-fixture',
                capabilitySnapshot: {},
                chunkerVersion: 'test-v1',
                createdBy: f.users[0]!,
            },
        });
    }
    async function fixture() {
        const text =
            'Texte conservé pour une citation. Text retained for a citation.\n';
        const upload = await f.owner.rag.documents.upload({
            requestId: randomUUID(),
            file: new File([text], `${randomUUID()}.txt`),
        });
        await processDocumentIngestions(prisma);
        const version = await prisma.documentVersion.findUniqueOrThrow({
            where: { id: upload.versionId },
            include: { extraction: true },
        });
        assert.ok(version.extraction);
        const gen = await generation(f.org);
        const candidate = await prisma.indexedDocument.create({
            data: {
                organizationId: f.org,
                collectionId: gen.collectionId,
                generationId: gen.id,
                documentId: upload.id,
                sourceVersionId: upload.versionId,
                extractionId: version.extraction.id,
                extractorVersion: version.extraction.extractorVersion,
                buildRevision: 1,
                metadataRevision: 1,
                sourceChangeSequence: 0n,
                fileName: version.fileName!,
                mediaType: version.mediaType,
                language: 'MIXED',
                documentCreatedAt: version.createdAt,
                sourceCreatedAt: version.createdAt,
            },
        });
        return {
            upload,
            version,
            gen,
            candidate,
            hold: { ...identity(candidate.id), versionId: upload.versionId },
        };
    }
    async function due(versionId: string) {
        await prisma.documentIngestion.update({
            where: { versionId },
            data: { leasedUntil: new Date(0) },
        });
        await prisma.documentCleanup.update({
            where: { versionId },
            data: {
                availableAt: new Date(0),
                scheduledAt: new Date(0),
                status: 'PENDING',
            },
        });
    }
    async function remove(doc: Awaited<ReturnType<typeof fixture>>) {
        await f.owner.rag.documents.delete({
            id: doc.upload.id,
            expectedVersionId: doc.upload.versionId,
            retentionDays: 0,
        });
        await due(doc.upload.versionId);
    }
    async function exists(key: string) {
        try {
            await s3.send(
                new HeadObjectCommand({ Bucket: data.bucket, Key: key })
            );
            return true;
        } catch (error) {
            if (error instanceof Error && error.name === 'NotFound')
                return false;
            throw error;
        }
    }
    async function finish(doc: Awaited<ReturnType<typeof fixture>>) {
        await runSerializableTransaction(prisma, (tx) =>
            releaseSourceHold(tx, identity(doc.candidate.id))
        );
        await due(doc.upload.versionId);
        await processDocumentCleanups(prisma);
        await prisma.indexGeneration.update({
            where: { id: doc.gen.id },
            data: { status: 'CLEANED' },
        });
        await prisma.collection.update({
            where: { id: doc.gen.collectionId },
            data: { deletedAt: new Date() },
        });
    }
    try {
        await t.test(
            'live and unexpired retired holds preserve exact source bytes and quota; expired/released holds cannot resurrect purged content',
            async () => {
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                const doc = await fixture();
                const hold = doc.hold;
                try {
                    const otherVersion =
                        await prisma.documentVersion.findFirstOrThrow({
                            where: {
                                organizationId: f.org,
                                id: { not: hold.versionId },
                            },
                            select: { id: true },
                        });
                    await assert.rejects(
                        prisma.documentSourceHold.create({
                            data: { ...hold, versionId: otherVersion.id },
                        }),
                        { code: 'P2003' }
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            acquireSourceHold(tx, {
                                ...hold,
                                organizationId: f.otherOrg,
                            })
                        ),
                        false
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            acquireSourceHold(tx, hold)
                        ),
                        true
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            acquireSourceHold(tx, hold)
                        ),
                        true
                    );
                    await prisma.indexedDocument.update({
                        where: { id: doc.candidate.id },
                        data: { status: 'PUBLISHED', publishedAt: new Date() },
                    });
                    // Citation renewals belong to a serving or gracefully retired
                    // generation, never an unprovisioned build fixture.
                    await prisma.indexGeneration.update({
                        where: { id: doc.gen.id },
                        data: { status: 'ACTIVE', activatedAt: new Date() },
                    });
                    const charged = (await f.owner.rag.quota({})).usage
                        .storageBytes;
                    await remove(doc);
                    await processDocumentCleanups(prisma);
                    assert.equal(await exists(doc.version.objectKey), true);
                    assert.equal(
                        (
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: hold.versionId },
                            })
                        ).contentState,
                        'AVAILABLE'
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        charged
                    );
                    const until = new Date(Date.now() + 120_000);
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            retireSourceHold(tx, {
                                ...identity(doc.candidate.id),
                                retainUntil: until,
                            })
                        ),
                        true
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            renewSourceHold(tx, {
                                ...identity(doc.candidate.id),
                                retainUntil: new Date(until.getTime() - 30_000),
                            })
                        ),
                        true
                    );
                    assert.deepEqual(
                        (
                            await prisma.documentSourceHold.findUniqueOrThrow({
                                where: { indexedDocumentId: doc.candidate.id },
                            })
                        ).retainUntil,
                        until
                    );
                    await due(hold.versionId);
                    await processDocumentCleanups(prisma);
                    assert.equal(
                        await exists(doc.version.extraction!.objectKey),
                        true
                    );
                    await prisma.documentSourceHold.update({
                        where: { indexedDocumentId: doc.candidate.id },
                        data: { retainUntil: new Date(0) },
                    });
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            renewSourceHold(tx, {
                                ...identity(doc.candidate.id),
                                retainUntil: until,
                            })
                        ),
                        false
                    );
                    await due(hold.versionId);
                    await processDocumentCleanups(prisma);
                    const purged =
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: hold.versionId },
                            include: {
                                extraction: true,
                                cleanup: true,
                                ingestion: true,
                            },
                        });
                    assert.equal(purged.contentState, 'PURGED');
                    assert.ok(purged.discardedAt);
                    assert.ok(purged.extraction?.discardedAt);
                    assert.equal(
                        purged.extraction.id,
                        doc.version.extraction!.id
                    );
                    assert.equal(purged.cleanup?.status, 'COMPLETE');
                    assert.equal(purged.ingestion?.reservedBytes, 0n);
                    assert.equal(await exists(doc.version.objectKey), false);
                    assert.equal(
                        await exists(doc.version.extraction!.objectKey),
                        false
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            acquireSourceHold(tx, hold)
                        ),
                        false
                    );
                    await assert.rejects(
                        f.owner.rag.documents.sourcePreview({
                            id: doc.upload.id,
                        }),
                        { code: 'NOT_FOUND' }
                    );
                } finally {
                    await finish(doc);
                }
            }
        );
        await t.test(
            'a hold transaction that owns the version fence before cleanup commits prevents external deletion',
            async () => {
                const doc = await fixture();
                let release = () => {};
                let acquired = () => {};
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const ready = new Promise<void>((resolve) => {
                    acquired = resolve;
                });
                await remove(doc);
                const holding = runSerializableTransaction(
                    prisma,
                    async (tx) => {
                        assert.equal(
                            await acquireSourceHold(tx, doc.hold),
                            true
                        );
                        acquired();
                        await gate;
                    },
                    { timeout: 10_000 }
                );
                await ready;
                const cleaning = processDocumentCleanups(prisma);
                try {
                    for (let attempt = 0; attempt < 100; attempt++) {
                        const task =
                            await prisma.documentCleanup.findUniqueOrThrow({
                                where: { versionId: doc.upload.versionId },
                            });
                        if (task.status === 'PROCESSING') break;
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assert.equal(
                        (
                            await prisma.documentCleanup.findUniqueOrThrow({
                                where: { versionId: doc.upload.versionId },
                            })
                        ).status,
                        'PROCESSING'
                    );
                    release();
                    await holding;
                    await cleaning;
                    assert.equal(await exists(doc.version.objectKey), true);
                    assert.equal(
                        (
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: doc.upload.versionId },
                            })
                        ).contentState,
                        'AVAILABLE'
                    );
                } finally {
                    release();
                    await Promise.allSettled([holding, cleaning]);
                    await finish(doc);
                }
            }
        );
        await t.test(
            'destructive claims exclude late holds and late missing-upload PUTs remain purged and charged until cleanup',
            async () => {
                let target: string | undefined;
                let method: 'DELETE' | 'PUT' | undefined = 'DELETE';
                let arrived = () => {};
                let release = () => {};
                let blocked = new Promise<void>((resolve) => {
                    arrived = resolve;
                });
                let gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const server = createServer((request, response) => {
                    void (async () => {
                        if (
                            request.method === method &&
                            (method === 'PUT' ||
                                request.url?.split('?')[0] === target)
                        ) {
                            method = undefined;
                            arrived();
                            await gate;
                        }
                        const upstream = httpRequest(
                            new URL(request.url!, endpoint),
                            {
                                method: request.method,
                                headers: request.headers,
                            },
                            (result) => {
                                response.writeHead(
                                    result.statusCode ?? 502,
                                    result.headers
                                );
                                result.pipe(response);
                            }
                        );
                        upstream.on('error', () => {
                            response.writeHead(502);
                            response.end();
                        });
                        request.pipe(upstream);
                    })();
                });
                server.listen(0, '127.0.0.1');
                await once(server, 'listening');
                const address = server.address();
                assert.ok(address && typeof address !== 'string');
                const proxy = `http://127.0.0.1:${address.port}`;
                const allowed = process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
                process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = [allowed, proxy]
                    .filter(Boolean)
                    .join(',');
                let doc: Awaited<ReturnType<typeof fixture>> | undefined;
                let cleaning: Promise<void> | undefined;
                try {
                    const proxyStorage = await f.owner.rag.credentials.create({
                        name: `Held DELETE ${randomUUID()}`,
                        data: { ...data, endpoint: proxy },
                    });
                    await f.owner.rag.credentials.activate({
                        id: proxyStorage.id,
                    });
                    doc = await fixture();
                    target = `/${data.bucket}/${doc.version.objectKey}`;
                    await remove(doc);
                    cleaning = processDocumentCleanups(prisma);
                    await Promise.race([
                        blocked,
                        cleaning.then(() =>
                            assert.fail(
                                'The cleaner did not reach the held DELETE.'
                            )
                        ),
                    ]);
                    assert.equal(
                        (
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: doc.upload.versionId },
                            })
                        ).contentState,
                        'DELETING'
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            acquireSourceHold(tx, doc!.hold)
                        ),
                        false
                    );
                    assert.equal(
                        await runSerializableTransaction(prisma, (tx) =>
                            renewSourceHold(tx, {
                                ...identity(doc!.candidate.id),
                                retainUntil: new Date(Date.now() + 60_000),
                            })
                        ),
                        false
                    );
                    assert.equal(await exists(doc.version.objectKey), true);
                    release();
                    await cleaning;
                    assert.equal(await exists(doc.version.objectKey), false);
                    assert.equal(
                        (
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: doc.upload.versionId },
                            })
                        ).contentState,
                        'PURGED'
                    );
                    const before = (await f.owner.rag.quota({})).usage
                        .storageBytes;
                    method = 'PUT';
                    blocked = new Promise<void>((resolve) => {
                        arrived = resolve;
                    });
                    gate = new Promise<void>((resolve) => {
                        release = resolve;
                    });
                    const name = `late-missing-${randomUUID()}.txt`;
                    const upload = f.owner.rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File(
                            [
                                'A late original must not revive a purged source.',
                            ],
                            name
                        ),
                    });
                    try {
                        await Promise.race([
                            blocked,
                            upload.then(() =>
                                assert.fail('The original PUT was not held.')
                            ),
                        ]);
                        const pending =
                            await prisma.documentVersion.findFirstOrThrow({
                                where: {
                                    organizationId: f.org,
                                    document: { name },
                                },
                            });
                        await prisma.documentIngestion.update({
                            where: { versionId: pending.id },
                            data: {
                                availableAt: new Date(0),
                                leasedUntil: new Date(0),
                            },
                        });
                        await processDocumentIngestions(prisma);
                        const missing =
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: pending.id },
                                include: { cleanup: true, ingestion: true },
                            });
                        assert.equal(missing.contentState, 'PURGED');
                        assert.ok(missing.discardedAt);
                        assert.equal(missing.ingestion?.reservedBytes, 0n);
                        assert.equal(missing.cleanup, null);
                        release();
                        await upload;
                        const orphan =
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: { id: pending.id },
                                include: { cleanup: true, ingestion: true },
                            });
                        assert.equal(orphan.contentState, 'PURGED');
                        assert.ok(orphan.discardedAt);
                        assert.equal(orphan.cleanup?.status, 'PENDING');
                        assert.equal(
                            orphan.ingestion?.reservedBytes,
                            2n * pending.byteSize
                        );
                        assert.equal(
                            (await f.owner.rag.quota({})).usage.storageBytes,
                            before + 2 * Number(pending.byteSize)
                        );
                        assert.equal(await exists(pending.objectKey), true);
                        await assert.rejects(
                            f.owner.rag.documents.download({
                                id: pending.documentId,
                            }),
                            { code: 'NOT_FOUND' }
                        );
                        await due(pending.id);
                        await processDocumentCleanups(prisma);
                        assert.equal(await exists(pending.objectKey), false);
                        assert.equal(
                            (await f.owner.rag.quota({})).usage.storageBytes,
                            before
                        );
                    } finally {
                        release();
                        await Promise.allSettled([upload]);
                    }
                } finally {
                    release();
                    await Promise.allSettled(cleaning ? [cleaning] : []);
                    if (doc) await finish(doc);
                    await f.owner.rag.credentials.activate({ id: storage.id });
                    if (allowed === undefined)
                        delete process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
                    else process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = allowed;
                    server.closeAllConnections();
                    await new Promise<void>((resolve, reject) =>
                        server.close((error) =>
                            error ? reject(error) : resolve()
                        )
                    );
                }
            }
        );
        await t.test(
            'native organization deletion rejects live objects and live index generations; empty/cleaned organizations still delete',
            async () => {
                function deleteOrganization(id: string) {
                    return app.request(
                        'http://localhost:3001/api/auth/organization/delete',
                        {
                            method: 'POST',
                            headers: {
                                ...f.owner.headers(),
                                'content-type': 'application/json',
                            },
                            body: JSON.stringify({ organizationId: id }),
                        }
                    );
                }
                async function createOrganization(name: string, slug: string) {
                    const result = await f.owner.post('organization/create', {
                        name,
                        slug: `${slug}-${randomUUID()}`,
                    });
                    const id: unknown = result.id;
                    assert.ok(typeof id === 'string');
                    return { id };
                }
                const context = await auth.$context;
                const membersBefore = await prisma.member.count({
                    where: { organizationId: f.org },
                });
                // Native auth deletes members before the organization. Its real
                // adapter transaction must roll those writes back if the final
                // database cleanup guard rejects work accepted after preflight.
                await assert.rejects(
                    context.adapter.transaction(async (adapter) => {
                        await adapter.deleteMany({
                            model: 'member',
                            where: [{ field: 'organizationId', value: f.org }],
                        });
                        await adapter.delete({
                            model: 'organization',
                            where: [{ field: 'id', value: f.org }],
                        });
                    })
                );
                assert.equal(
                    await prisma.member.count({
                        where: { organizationId: f.org },
                    }),
                    membersBefore
                );
                const response = await deleteOrganization(f.org);
                assert.equal(response.status, 409);
                await assert.rejects(
                    prisma.organization.delete({ where: { id: f.org } })
                );
                assert.ok(
                    await prisma.organization.findUnique({
                        where: { id: f.org },
                    })
                );
                assert.equal(
                    (await response.json()).code,
                    'ORGANIZATION_CONTENT_CLEANUP_REQUIRED'
                );
                const empty = await createOrganization(
                    'Empty deletion fixture',
                    'empty'
                );
                assert.equal((await deleteOrganization(empty.id)).status, 200);
                // Observe the descendant INSERT waiting on PostgreSQL, rather than
                // relying on a sleep to assume the organization lock was acquired.
                const racing = await createOrganization(
                    'Concurrent deletion fixture',
                    'racing'
                );
                const pendingDocument = await prisma.document.create({
                    data: {
                        organizationId: racing.id,
                        name: 'Never uploaded.txt',
                    },
                });
                const location = await prisma.storageLocation.create({
                    data: {
                        organizationId: racing.id,
                        fingerprint: randomUUID(),
                        endpoint: data.endpoint,
                        bucket: data.bucket,
                        region: data.region,
                        forcePathStyle: true,
                    },
                });
                let deleted = () => {};
                let releaseDelete = () => {};
                const deletedReady = new Promise<void>((resolve) => {
                    deleted = resolve;
                });
                const deleteGate = new Promise<void>((resolve) => {
                    releaseDelete = resolve;
                });
                const deleting = prisma.$transaction(
                    async (tx) => {
                        await tx.organization.delete({
                            where: { id: racing.id },
                        });
                        deleted();
                        await deleteGate;
                    },
                    { timeout: 10_000 }
                );
                await deletedReady;
                let identified: (pid: number) => void = () => {};
                const pidReady = new Promise<number>((resolve) => {
                    identified = resolve;
                });
                const inserting = prisma.$transaction(
                    async (tx) => {
                        // SQL is limited to observing a backend PID/wait; the actual
                        // destructive/content mutations use the Prisma operations.
                        const [backend] = await tx.$queryRaw<
                            { pid: number }[]
                        >`SELECT pg_backend_pid() AS pid`;
                        identified(backend!.pid);
                        await tx.documentVersion.create({
                            data: {
                                organizationId: racing.id,
                                documentId: pendingDocument.id,
                                version: 1,
                                storageLocationId: location.id,
                                objectKey: `${racing.id}/${randomUUID()}/original`,
                                sha256: '0'.repeat(64),
                                byteSize: 1n,
                                mediaType: 'text/plain',
                            },
                        });
                    },
                    { timeout: 10_000 }
                );
                void inserting.catch(() => {});
                try {
                    const pid = await pidReady;
                    let locked = false;
                    for (let attempt = 0; attempt < 100; attempt++) {
                        const [backend] = await prisma.$queryRaw<
                            { waiting: boolean }[]
                        >`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`;
                        if (backend?.waiting) {
                            locked = true;
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                    assert.equal(
                        locked,
                        true,
                        'The descendant INSERT must wait for organization deletion.'
                    );
                    releaseDelete();
                    await deleting;
                    await assert.rejects(inserting);
                    assert.equal(
                        await prisma.documentVersion.count({
                            where: { organizationId: racing.id },
                        }),
                        0
                    );
                    assert.equal(
                        await prisma.organization.findUnique({
                            where: { id: racing.id },
                        }),
                        null
                    );
                } finally {
                    releaseDelete();
                    await Promise.allSettled([deleting, inserting]);
                }
                const indexed = await createOrganization(
                    'Index deletion fixture',
                    'indexed'
                );
                const gen = await generation(indexed.id);
                const rejected = await deleteOrganization(indexed.id);
                assert.equal(rejected.status, 409);
                await assert.rejects(
                    prisma.organization.delete({ where: { id: indexed.id } })
                );
                assert.equal(
                    (await rejected.json()).code,
                    'ORGANIZATION_CONTENT_CLEANUP_REQUIRED'
                );
                assert.ok(
                    await prisma.organization.findUnique({
                        where: { id: indexed.id },
                    })
                );
                await prisma.indexGeneration.update({
                    where: { id: gen.id },
                    data: { status: 'CLEANED' },
                });
                assert.equal(
                    (await deleteOrganization(indexed.id)).status,
                    200
                );
                assert.equal(
                    await prisma.organization.findUnique({
                        where: { id: indexed.id },
                    }),
                    null
                );
                const retained = await createOrganization(
                    'Purged metadata deletion fixture',
                    'purged'
                );
                await f.owner.post('organization/set-active', {
                    organizationId: retained.id,
                });
                try {
                    const credential = await f.owner.rag.credentials.create({
                        name: 'Private source storage',
                        data,
                    });
                    await f.owner.rag.credentials.activate({
                        id: credential.id,
                    });
                    const upload = await f.owner.rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File(
                            ['Retained metadata; purged private bytes.'],
                            'retained.txt'
                        ),
                    });
                    await processDocumentIngestions(prisma);
                    await f.owner.rag.documents.delete({
                        id: upload.id,
                        expectedVersionId: upload.versionId,
                        retentionDays: 0,
                    });
                    await due(upload.versionId);
                    await processDocumentCleanups(prisma);
                    const purged =
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: upload.versionId },
                            include: { extraction: true, cleanup: true },
                        });
                    assert.equal(purged.contentState, 'PURGED');
                    assert.ok(purged.discardedAt);
                    assert.ok(purged.extraction?.discardedAt);
                    assert.equal(purged.cleanup?.status, 'COMPLETE');
                    assert.equal(await exists(purged.objectKey), false);
                    assert.equal(
                        await exists(purged.extraction.objectKey),
                        false
                    );
                    assert.equal(
                        (await deleteOrganization(retained.id)).status,
                        200
                    );
                    assert.equal(
                        await prisma.documentVersion.count({
                            where: { organizationId: retained.id },
                        }),
                        0
                    );
                    assert.equal(
                        await prisma.documentExtraction.count({
                            where: { organizationId: retained.id },
                        }),
                        0
                    );
                    assert.equal(
                        await prisma.credentials.count({
                            where: { organizationId: retained.id },
                        }),
                        0
                    );
                    assert.equal(
                        await prisma.storageLocation.count({
                            where: { organizationId: retained.id },
                        }),
                        0
                    );
                } finally {
                    await f.owner.post('organization/set-active', {
                        organizationId: f.org,
                    });
                }
            }
        );
    } finally {
        s3.destroy();
    }
}
