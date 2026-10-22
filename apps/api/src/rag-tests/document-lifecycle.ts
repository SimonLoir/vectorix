import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { fixture as f, profile, readGrant, rpc } from './fixtures';

/** Exercise immutable versions, tombstones and durable cleanup against real private RustFS. */
export async function documentLifecycleTests(t: TestContext) {
    const endpoint = process.env.VECTORIX_DEFAULT_S3_ENDPOINT!;
    const bucket = process.env.VECTORIX_DEFAULT_S3_BUCKET!;
    const accessKeyId = process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!;
    const data = {
        provider: 'S3' as const,
        endpoint,
        bucket,
        region: 'us-east-1',
        forcePathStyle: true,
        accessKeyId,
        secretAccessKey,
    };
    let storage = await f.owner.rag.credentials.create({
        name: 'Lifecycle storage',
        data,
    });
    await f.owner.rag.credentials.activate({ id: storage.id });
    const s3 = new S3Client({
        endpoint,
        region: data.region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
    });
    const run = randomUUID();
    const originalText = 'Version originale — Original version\n';
    const replacementText = 'Version remplacée — Replaced version\n';

    async function uploadReady(suffix: string, text = originalText) {
        const result = await f.owner.rag.documents.upload({
            requestId: randomUUID(),
            file: new File([text], `${run}-${suffix}.txt`),
        });
        for (let attempt = 0; attempt < 5; attempt++) {
            await processDocumentIngestions(prisma);
            const task = await prisma.documentIngestion.findUniqueOrThrow({
                where: { versionId: result.versionId },
            });
            if (task.status === 'READY') return result;
        }
        assert.fail('The fixture extraction did not become ready.');
    }
    function version(id: string) {
        return prisma.documentVersion.findUniqueOrThrow({
            where: { id },
            include: { extraction: true, cleanup: true, ingestion: true },
        });
    }
    async function objectExists(key: string) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
            return true;
        } catch (error) {
            if (error instanceof Error && error.name === 'NotFound')
                return false;
            throw error;
        }
    }
    /** Advance only this test's durable deadlines; no wall-clock sleeps or application databases. */
    async function cleanupDue(documentId: string) {
        const versions = await prisma.documentVersion.findMany({
            where: { organizationId: f.org, documentId },
            select: { id: true },
        });
        const versionId = { in: versions.map((item) => item.id) };
        await prisma.documentIngestion.updateMany({
            where: { organizationId: f.org, versionId },
            data: { leasedUntil: new Date(0), updatedAt: new Date(0) },
        });
        await prisma.documentCleanup.updateMany({
            where: {
                organizationId: f.org,
                versionId,
                status: { not: 'COMPLETE' },
            },
            data: {
                scheduledAt: new Date(0),
                availableAt: new Date(0),
                leasedUntil: new Date(0),
                updatedAt: new Date(0),
            },
        });
    }
    async function completeCleanup(documentId: string) {
        await cleanupDue(documentId);
        for (let attempt = 0; attempt < 5; attempt++) {
            await processDocumentCleanups(prisma);
            const outstanding = await prisma.documentCleanup.count({
                where: {
                    organizationId: f.org,
                    version: { documentId },
                    status: { not: 'COMPLETE' },
                },
            });
            if (!outstanding) return;
        }
        assert.fail('The fixture cleanup did not complete.');
    }
    try {
        await t.test(
            'replacement publishes atomically, retains collection access, and respects previous-version retention',
            async () => {
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                const doc = await uploadReady('replace');
                const collection = await f.owner.rag.collections.create({
                    name: `${run}-replacement`,
                    profile,
                });
                await f.owner.rag.documents.setCollection({
                    id: doc.id,
                    collectionId: collection.id,
                    attached: true,
                });
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                const input = {
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                    requestId: randomUUID(),
                    file: new File([replacementText], `${run}-replacement.md`),
                    retentionDays: 7,
                };
                const replaced = await f.owner.rag.documents.replace(input);
                assert.deepEqual(
                    await f.owner.rag.documents.replace(input),
                    replaced
                );
                await assert.rejects(
                    f.owner.rag.documents.replace({
                        ...input,
                        file: new File(['different'], input.file.name),
                    }),
                    { code: 'CONFLICT' }
                );
                assert.equal(
                    await (
                        await f.reader.rag.documents.download({ id: doc.id })
                    ).text(),
                    originalText
                );
                assert.equal(
                    (await f.reader.rag.documents.preview({ id: doc.id }))
                        .version,
                    1
                );
                const pending = await f.owner.rag.documents.lifecycle({
                    id: doc.id,
                });
                assert.equal(pending.publishedVersionId, doc.versionId);
                assert.equal(pending.latestVersionId, replaced.versionId);
                assert.equal(pending.total, 2);
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before +
                        2 * new TextEncoder().encode(originalText).length +
                        2 * input.file.size
                );
                await processDocumentIngestions(prisma);
                const published = await f.reader.rag.documents.download({
                    id: doc.id,
                });
                assert.equal(published.name, input.file.name);
                assert.equal(await published.text(), replacementText);
                assert.equal(
                    (await f.reader.rag.documents.preview({ id: doc.id }))
                        .version,
                    2
                );
                assert.equal(
                    await prisma.collectionDocument.count({
                        where: { documentId: doc.id },
                    }),
                    1
                );
                const lifecycle = await f.owner.rag.documents.lifecycle({
                    id: doc.id,
                });
                assert.equal(lifecycle.publishedVersionId, replaced.versionId);
                assert.equal(lifecycle.versions[0]?.fileName, input.file.name);
                assert.equal(lifecycle.versions[1]?.cleanup?.status, 'PENDING');
                assert.ok(
                    lifecycle.versions[1]!.cleanup!.scheduledAt > new Date()
                );
                await processDocumentCleanups(prisma);
                assert.equal((await version(doc.versionId)).discardedAt, null);
                const previous = await version(doc.versionId);
                assert.equal(await objectExists(previous.objectKey), true);
                assert.ok(!JSON.stringify(lifecycle).includes('objectKey'));
                assert.ok(
                    !JSON.stringify(lifecycle).includes('secretAccessKey')
                );
                const current = await version(replaced.versionId);
                await completeCleanup(doc.id);
                assert.equal(await objectExists(previous.objectKey), false);
                assert.equal(
                    await objectExists(previous.extraction!.objectKey),
                    false
                );
                assert.equal(
                    (await version(doc.versionId)).cleanup?.status,
                    'COMPLETE'
                );
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before +
                        Number(current.byteSize + current.extraction!.byteSize)
                );
                assert.equal(await objectExists(current.objectKey), true);
            }
        );
        await t.test(
            'failed replacement and retry preserve the previous publication until a newer valid version is ready',
            async () => {
                const doc = await uploadReady('failed-replacement');
                const bad = await f.owner.rag.documents.replace({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                    requestId: randomUUID(),
                    file: new File(
                        [new Uint8Array([0xff, 0x00])],
                        `${run}-invalid.txt`
                    ),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                const failed = await f.owner.rag.documents.lifecycle({
                    id: doc.id,
                });
                assert.equal(failed.publishedVersionId, doc.versionId);
                assert.equal(failed.latestVersionId, bad.versionId);
                assert.equal(
                    failed.versions[0]?.task?.errorCode,
                    'TEXT_INVALID'
                );
                assert.equal(
                    (await f.owner.rag.documents.get({ id: doc.id })).status,
                    'READY'
                );
                assert.equal(
                    await (
                        await f.owner.rag.documents.download({ id: doc.id })
                    ).text(),
                    originalText
                );
                await cleanupDue(doc.id);
                await processDocumentCleanups(prisma);
                assert.equal((await version(doc.versionId)).discardedAt, null);
                const reserved = (await version(bad.versionId)).ingestion!
                    .reservedBytes;
                await f.owner.rag.documents.retry({ id: doc.id });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (await version(bad.versionId)).ingestion!.reservedBytes,
                    reserved
                );
                assert.equal(
                    (await f.owner.rag.documents.details({ id: doc.id }))
                        .version?.id,
                    doc.versionId
                );
                const good = await f.owner.rag.documents.replace({
                    id: doc.id,
                    expectedVersionId: bad.versionId,
                    requestId: randomUUID(),
                    file: new File([replacementText], `${run}-recovered.txt`),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                await assert.rejects(
                    f.owner.rag.documents.retry({ id: doc.id }),
                    { code: 'CONFLICT' }
                );
                await completeCleanup(doc.id);
                assert.equal(
                    (await version(doc.versionId)).cleanup?.status,
                    'COMPLETE'
                );
                assert.equal(
                    (await version(bad.versionId)).cleanup?.status,
                    'COMPLETE'
                );
                assert.equal(
                    (await version(bad.versionId)).ingestion!.reservedBytes,
                    0n
                );
                assert.equal(
                    (await f.owner.rag.documents.lifecycle({ id: doc.id }))
                        .publishedVersionId,
                    good.versionId
                );
            }
        );
        await t.test(
            'concurrent replacements enforce the expected version without partial versions or cross-organization access',
            async () => {
                const doc = await uploadReady('race');
                const results = await Promise.allSettled(
                    [1, 2].map((index) =>
                        f.owner.rag.documents.replace({
                            id: doc.id,
                            expectedVersionId: doc.versionId,
                            requestId: randomUUID(),
                            file: new File(
                                [`Replacement ${index}`],
                                `${run}-race-${index}.txt`
                            ),
                            retentionDays: 0,
                        })
                    )
                );
                assert.equal(
                    results.filter((result) => result.status === 'fulfilled')
                        .length,
                    1
                );
                const rejected = results.find(
                    (result) => result.status === 'rejected'
                );
                assert.ok(rejected?.status === 'rejected');
                assert.equal(rejected.reason.code, 'CONFLICT');
                assert.equal(
                    await prisma.documentVersion.count({
                        where: { documentId: doc.id },
                    }),
                    2
                );
                await assert.rejects(
                    f.other.rag.documents.replace({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                        requestId: randomUUID(),
                        file: new File(['foreign'], 'foreign.txt'),
                    }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    f.other.rag.documents.lifecycle({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    f.reader.rag.documents.lifecycle({ id: doc.id }),
                    { code: 'FORBIDDEN' }
                );
                await processDocumentIngestions(prisma);
                await assert.rejects(
                    f.owner.rag.documents.replace({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                        requestId: randomUUID(),
                        file: new File(['stale'], 'stale.txt'),
                    }),
                    { code: 'CONFLICT' }
                );
                await completeCleanup(doc.id);
            }
        );
        await t.test(
            'deletion denies readers and scoped keys immediately while managers inspect retained cleanup metadata',
            async () => {
                const doc = await uploadReady('delete');
                const collection = await f.owner.rag.collections.create({
                    name: `${run}-delete`,
                    profile,
                });
                await f.owner.rag.documents.setCollection({
                    id: doc.id,
                    collectionId: collection.id,
                    attached: true,
                });
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Deleted document scope',
                        permissions: {
                            ragLibrary: ['read'],
                            ragCollection: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId: collection.id,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key }));
                assert.equal(
                    await (
                        await api.admin.rag.documents.download({ id: doc.id })
                    ).text(),
                    originalText
                );
                await assert.rejects(
                    f.reader.rag.documents.delete({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                    }),
                    { code: 'FORBIDDEN' }
                );
                await assert.rejects(
                    api.admin.rag.documents.delete({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                    }),
                    { code: 'FORBIDDEN' }
                );
                const before = await f.owner.rag.quota({});
                await f.owner.rag.documents.delete({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                    retentionDays: 1,
                });
                await f.owner.rag.documents.delete({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                    retentionDays: 1,
                });
                assert.equal(
                    await prisma.collectionDocument.count({
                        where: { documentId: doc.id },
                    }),
                    0
                );
                for (const client of [
                    f.owner.rag,
                    f.reader.rag,
                    api.admin.rag,
                ]) {
                    for (const action of [
                        'get',
                        'details',
                        'preview',
                        'download',
                    ] as const) {
                        await assert.rejects(
                            client.documents[action]({ id: doc.id }),
                            { code: 'NOT_FOUND' }
                        );
                    }
                }
                await assert.rejects(
                    f.other.rag.documents.lifecycle({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(f.reader.rag.documents.trash({}), {
                    code: 'FORBIDDEN',
                });
                await assert.rejects(
                    api.admin.rag.documents.lifecycle({ id: doc.id }),
                    { code: 'FORBIDDEN' }
                );
                const trashed = await f.owner.rag.documents.trash({
                    query: `${run}-delete`,
                });
                assert.equal(trashed.total, 1);
                assert.equal(trashed.items[0]?.id, doc.id);
                const lifecycle = await f.owner.rag.documents.lifecycle({
                    id: doc.id,
                });
                assert.ok(lifecycle.deletedAt);
                assert.equal(lifecycle.document.status, 'DELETED');
                assert.equal(lifecycle.publishedVersionId, null);
                assert.equal(lifecycle.versions[0]?.cleanup?.reason, 'DELETED');
                await processDocumentCleanups(prisma);
                assert.equal((await version(doc.versionId)).discardedAt, null);
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before.usage.storageBytes
                );
                assert.equal(
                    (await f.owner.rag.quota({})).usage.documents,
                    before.usage.documents - 1
                );
                await completeCleanup(doc.id);
                const after = await version(doc.versionId);
                assert.ok(after.discardedAt);
                assert.ok(after.extraction?.discardedAt);
                assert.equal(after.contentState, 'PURGED');
                assert.equal(after.ingestion?.reservedBytes, 0n);
                assert.equal(after.cleanup?.status, 'COMPLETE');
                assert.ok(after.cleanup.completedAt);
                const quota = await f.owner.rag.quota({});
                assert.equal(
                    quota.usage.storageBytes,
                    before.usage.storageBytes -
                        2 * new TextEncoder().encode(originalText).length
                );
                await Promise.all([
                    processDocumentCleanups(prisma),
                    processDocumentCleanups(prisma),
                ]);
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    quota.usage.storageBytes
                );
            }
        );
        await t.test(
            'cleanup failures retain charged capacity, stop after bounded attempts, and support an authorized retry',
            async () => {
                const doc = await uploadReady('cleanup-retry');
                await f.owner.rag.documents.delete({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                });
                await cleanupDue(doc.id);
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                storage = await f.owner.rag.credentials.update({
                    id: storage.id,
                    name: storage.name,
                    expectedRevision: storage.revision,
                    data: {
                        ...data,
                        secretAccessKey: 'invalid-cleanup-secret',
                    },
                });
                for (let attempt = 0; attempt < 5; attempt++) {
                    await prisma.documentCleanup.update({
                        where: { versionId: doc.versionId },
                        data: { availableAt: new Date(0) },
                    });
                    await processDocumentCleanups(prisma);
                }
                const failed = await version(doc.versionId);
                assert.equal(failed.cleanup?.status, 'FAILED');
                assert.equal(failed.cleanup.errorCode, 'STORAGE_UNAVAILABLE');
                assert.equal(failed.cleanup.attempts, 5);
                assert.equal(failed.discardedAt, null);
                assert.ok(failed.extraction);
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before
                );
                await assert.rejects(
                    f.other.rag.documents.retryCleanup({
                        id: doc.id,
                        versionId: doc.versionId,
                    }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    f.reader.rag.documents.retryCleanup({
                        id: doc.id,
                        versionId: doc.versionId,
                    }),
                    { code: 'FORBIDDEN' }
                );
                storage = await f.owner.rag.credentials.update({
                    id: storage.id,
                    name: storage.name,
                    expectedRevision: storage.revision,
                    data,
                });
                await f.owner.rag.documents.retryCleanup({
                    id: doc.id,
                    versionId: doc.versionId,
                });
                assert.equal(
                    (await version(doc.versionId)).cleanup?.attempts,
                    0
                );
                await completeCleanup(doc.id);
                assert.equal(await objectExists(failed.objectKey), false);
                assert.equal(
                    await objectExists(failed.extraction!.objectKey),
                    false
                );
                await assert.rejects(
                    f.owner.rag.documents.retryCleanup({
                        id: doc.id,
                        versionId: doc.versionId,
                    }),
                    { code: 'CONFLICT' }
                );
            }
        );
        await t.test(
            'expired cleanup leases recover once and authorized deletion still completes after organization suspension',
            async () => {
                const doc = await uploadReady('cleanup-lease');
                await f.owner.rag.documents.delete({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                });
                await cleanupDue(doc.id);
                await prisma.documentCleanup.update({
                    where: { versionId: doc.versionId },
                    data: {
                        status: 'PROCESSING',
                        attempts: 1,
                        leaseToken: randomUUID(),
                        leasedUntil: new Date(0),
                    },
                });
                await prisma.organization.update({
                    where: { id: f.org },
                    data: { isActive: false },
                });
                try {
                    await Promise.all([
                        processDocumentCleanups(prisma),
                        processDocumentCleanups(prisma),
                    ]);
                    assert.equal(
                        (await version(doc.versionId)).cleanup?.status,
                        'COMPLETE'
                    );
                    assert.equal(
                        (await version(doc.versionId)).cleanup?.attempts,
                        2
                    );
                } finally {
                    await prisma.organization.update({
                        where: { id: f.org },
                        data: { isActive: true },
                    });
                }
                assert.equal(
                    await objectExists(
                        (await version(doc.versionId)).objectKey
                    ),
                    false
                );
            }
        );
        await t.test(
            'a late original PUT reopens completed cleanup and restores charged capacity without republishing deleted content',
            async () => {
                let release!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                let arrived!: () => void;
                const held = new Promise<void>((resolve) => {
                    arrived = resolve;
                });
                const server = createServer((request, response) => {
                    void (async () => {
                        if (
                            request.method === 'PUT' &&
                            request.url?.split('?')[0]?.endsWith('/original')
                        ) {
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
                const previousAllowed =
                    process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
                process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = [
                    previousAllowed,
                    proxy,
                ]
                    .filter(Boolean)
                    .join(',');
                try {
                    const proxyStorage = await f.owner.rag.credentials.create({
                        name: 'Delayed lifecycle storage',
                        data: { ...data, endpoint: proxy },
                    });
                    await f.owner.rag.credentials.activate({
                        id: proxyStorage.id,
                    });
                    const before = (await f.owner.rag.quota({})).usage
                        .storageBytes;
                    const name = `${run}-delayed.txt`;
                    const upload = Promise.allSettled([
                        f.owner.rag.documents.upload({
                            requestId: randomUUID(),
                            file: new File(['Delayed original'], name),
                        }),
                    ]);
                    await Promise.race([
                        held,
                        upload.then(() =>
                            assert.fail(
                                'Upload completed before the original PUT reached the proxy.'
                            )
                        ),
                    ]);
                    const doc = await prisma.document.findFirstOrThrow({
                        where: { organizationId: f.org, name },
                        include: { versions: true },
                    });
                    const first = doc.versions[0]!;
                    await f.owner.rag.documents.delete({
                        id: doc.id,
                        expectedVersionId: first.id,
                    });
                    await processDocumentCleanups(prisma);
                    assert.equal((await version(first.id)).discardedAt, null);
                    // Deliberately exceed the normal I/O bound by advancing only this fixture's
                    // deadlines: cleanup completes before the held network write lands.
                    await completeCleanup(doc.id);
                    assert.equal(
                        (await version(first.id)).cleanup?.status,
                        'COMPLETE'
                    );
                    assert.equal(await objectExists(first.objectKey), false);
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                    release();
                    await upload;
                    const reopened = await version(first.id);
                    assert.equal(await objectExists(first.objectKey), true);
                    assert.equal(reopened.cleanup?.status, 'PENDING');
                    assert.equal(reopened.cleanup.completedAt, null);
                    assert.ok(reopened.discardedAt);
                    assert.equal(reopened.contentState, 'PURGED');
                    assert.equal(
                        reopened.ingestion?.reservedBytes,
                        2n * first.byteSize
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before + 2 * Number(first.byteSize)
                    );
                    await processDocumentIngestions(prisma);
                    assert.equal(
                        (
                            await prisma.document.findUniqueOrThrow({
                                where: { id: doc.id },
                            })
                        ).status,
                        'DELETED'
                    );
                    await assert.rejects(
                        f.owner.rag.documents.download({ id: doc.id }),
                        { code: 'NOT_FOUND' }
                    );
                    await completeCleanup(doc.id);
                    assert.equal(await objectExists(first.objectKey), false);
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                    assert.equal(
                        await prisma.documentExtraction.count({
                            where: { versionId: first.id },
                        }),
                        0
                    );
                } finally {
                    release();
                    if (previousAllowed === undefined)
                        delete process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
                    else
                        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS =
                            previousAllowed;
                    await f.owner.rag.credentials.activate({ id: storage.id });
                    server.closeAllConnections();
                    await new Promise<void>((resolve, reject) =>
                        server.close((error) =>
                            error ? reject(error) : resolve()
                        )
                    );
                }
            }
        );
    } finally {
        s3.destroy();
    }
}
