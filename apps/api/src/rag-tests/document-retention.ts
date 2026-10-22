import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { fixture as f } from './fixtures';

/** Hold real S3 deletion after the cleanup claim to cover retention changes during external I/O. */
export async function documentRetentionTests(t: TestContext) {
    const endpoint = process.env.VECTORIX_DEFAULT_S3_ENDPOINT!;
    const bucket = process.env.VECTORIX_DEFAULT_S3_BUCKET!;
    const data = {
        provider: 'S3' as const,
        endpoint,
        bucket,
        region: 'us-east-1',
        forcePathStyle: true,
        accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
    };
    const storage = await f.owner.rag.credentials.create({
        name: 'Retention storage',
        data,
    });
    const s3 = new S3Client({
        ...data,
        credentials: {
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
        },
    });
    let heldPath: string | undefined;
    let arrived = () => {};
    let release = () => {};
    let gate = Promise.resolve();
    const server = createServer((request, response) => {
        void (async () => {
            if (
                request.method === 'DELETE' &&
                request.url?.split('?')[0] === heldPath
            ) {
                heldPath = undefined;
                arrived();
                await gate;
            }
            const upstream = httpRequest(
                new URL(request.url!, endpoint),
                { method: request.method, headers: request.headers },
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
    const previousAllowed = process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
    process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = [previousAllowed, proxy]
        .filter(Boolean)
        .join(',');
    const run = randomUUID();
    const firstText = 'Original conservé — Retained original\n';
    const secondText = 'Deuxième version — Second version\n';
    const thirdText = 'Troisième version — Third version\n';

    function version(id: string) {
        return prisma.documentVersion.findUniqueOrThrow({
            where: { id },
            include: { cleanup: true, ingestion: true, extraction: true },
        });
    }
    async function ready(versionId: string) {
        await processDocumentIngestions(prisma);
        assert.equal((await version(versionId)).status, 'READY');
    }
    async function upload(suffix: string) {
        const result = await f.owner.rag.documents.upload({
            requestId: randomUUID(),
            file: new File([firstText], `${run}-${suffix}.txt`),
        });
        await ready(result.versionId);
        return result;
    }
    async function replace(
        documentId: string,
        expectedVersionId: string,
        text: string,
        retentionDays: number
    ) {
        const result = await f.owner.rag.documents.replace({
            id: documentId,
            expectedVersionId,
            requestId: randomUUID(),
            file: new File([text], `${run}-${randomUUID()}.txt`),
            retentionDays,
        });
        await ready(result.versionId);
        return result;
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
    /** Advance only this test document's deadlines after race assertions, then remove its real objects. */
    async function removeFixture(documentId: string) {
        const latest = await prisma.documentVersion.findFirstOrThrow({
            where: { organizationId: f.org, documentId },
            orderBy: { version: 'desc' },
        });
        await f.owner.rag.documents.delete({
            id: documentId,
            expectedVersionId: latest.id,
            retentionDays: 0,
        });
        await prisma.documentIngestion.updateMany({
            where: { organizationId: f.org, version: { documentId } },
            data: { leasedUntil: new Date(0) },
        });
        await prisma.documentCleanup.updateMany({
            where: {
                organizationId: f.org,
                version: { documentId },
                status: { not: 'COMPLETE' },
            },
            data: {
                status: 'PENDING',
                scheduledAt: new Date(0),
                availableAt: new Date(0),
                leasedUntil: null,
                leaseToken: null,
            },
        });
        await processDocumentCleanups(prisma);
        assert.equal(
            await prisma.documentCleanup.count({
                where: {
                    organizationId: f.org,
                    version: { documentId },
                    status: { not: 'COMPLETE' },
                },
            }),
            0
        );
    }

    try {
        const proxyStorage = await f.owner.rag.credentials.create({
            name: 'In-flight retention storage',
            data: { ...data, endpoint: proxy },
        });
        await f.owner.rag.credentials.activate({ id: proxyStorage.id });
        for (const action of ['replacement', 'deletion'] as const) {
            await t.test(
                `${action} with longer retention preserves an in-flight cleanup claim and completes physical deletion`,
                async () => {
                    const before = (await f.owner.rag.quota({})).usage;
                    const doc = await upload(action);
                    let cleaning: Promise<void> | undefined;
                    try {
                        const second = await replace(
                            doc.id,
                            doc.versionId,
                            secondText,
                            0
                        );
                        const original = await version(doc.versionId);
                        assert.ok(original.extraction);
                        assert.equal(original.cleanup?.status, 'PENDING');
                        const held = new Promise<void>((resolve) => {
                            arrived = resolve;
                        });
                        gate = new Promise<void>((resolve) => {
                            release = resolve;
                        });
                        heldPath = `/${bucket}/${original.objectKey}`;
                        cleaning = processDocumentCleanups(prisma);
                        await Promise.race([
                            held,
                            cleaning.then(() =>
                                assert.fail(
                                    'Cleanup finished before its original DELETE reached the proxy.'
                                )
                            ),
                        ]);
                        const claimed = (await version(doc.versionId)).cleanup!;
                        assert.equal(claimed.status, 'PROCESSING');
                        assert.ok(claimed.leaseToken);
                        assert.ok(claimed.leasedUntil! > new Date());
                        let currentVersionId = second.versionId;
                        if (action === 'replacement') {
                            const third = await replace(
                                doc.id,
                                second.versionId,
                                thirdText,
                                365
                            );
                            currentVersionId = third.versionId;
                        } else {
                            await f.owner.rag.documents.delete({
                                id: doc.id,
                                expectedVersionId: second.versionId,
                                retentionDays: 365,
                            });
                            for (const operation of [
                                'get',
                                'preview',
                                'download',
                            ] as const)
                                await assert.rejects(
                                    f.owner.rag.documents[operation]({
                                        id: doc.id,
                                    }),
                                    { code: 'NOT_FOUND' }
                                );
                        }
                        const unchanged = (await version(doc.versionId))
                            .cleanup!;
                        assert.equal(unchanged.status, 'PROCESSING');
                        assert.equal(unchanged.leaseToken, claimed.leaseToken);
                        assert.deepEqual(
                            unchanged.leasedUntil,
                            claimed.leasedUntil
                        );
                        assert.deepEqual(
                            unchanged.scheduledAt,
                            claimed.scheduledAt
                        );
                        assert.deepEqual(
                            unchanged.availableAt,
                            claimed.availableAt
                        );
                        assert.equal(unchanged.attempts, claimed.attempts);
                        release();
                        await cleaning;
                        const cleaned = await version(doc.versionId);
                        assert.equal(cleaned.cleanup?.status, 'COMPLETE');
                        assert.ok(cleaned.cleanup.completedAt);
                        assert.ok(cleaned.discardedAt);
                        assert.equal(cleaned.extraction, null);
                        assert.equal(cleaned.ingestion?.reservedBytes, 0n);
                        assert.equal(
                            await objectExists(original.objectKey),
                            false
                        );
                        assert.equal(
                            await objectExists(original.extraction.objectKey),
                            false
                        );
                        const retained = await version(second.versionId);
                        assert.ok(retained.extraction);
                        assert.equal(retained.discardedAt, null);
                        assert.equal(
                            await objectExists(retained.objectKey),
                            true
                        );
                        assert.equal(retained.cleanup?.status, 'PENDING');
                        assert.ok(retained.cleanup.scheduledAt > new Date());
                        let expectedBytes =
                            before.storageBytes +
                            Number(
                                retained.byteSize + retained.extraction.byteSize
                            );
                        if (action === 'replacement') {
                            const current = await version(currentVersionId);
                            assert.ok(current.extraction);
                            assert.equal(current.status, 'READY');
                            assert.equal(current.discardedAt, null);
                            assert.equal(
                                await (
                                    await f.owner.rag.documents.download({
                                        id: doc.id,
                                    })
                                ).text(),
                                thirdText
                            );
                            assert.equal(
                                (
                                    await f.owner.rag.documents.lifecycle({
                                        id: doc.id,
                                    })
                                ).publishedVersionId,
                                currentVersionId
                            );
                            expectedBytes += Number(
                                current.byteSize + current.extraction.byteSize
                            );
                        } else {
                            assert.equal(
                                (
                                    await f.owner.rag.documents.lifecycle({
                                        id: doc.id,
                                    })
                                ).publishedVersionId,
                                null
                            );
                            assert.equal(retained.status, 'DELETED');
                        }
                        const usage = (await f.owner.rag.quota({})).usage;
                        assert.equal(usage.storageBytes, expectedBytes);
                        assert.equal(
                            usage.documents,
                            before.documents +
                                (action === 'replacement' ? 1 : 0)
                        );
                    } finally {
                        release();
                        if (cleaning) await cleaning;
                        await removeFixture(doc.id);
                    }
                }
            );
        }
        await t.test(
            'another replacement preserves the earlier pending retention deadline and retry state',
            async () => {
                const doc = await upload('pending');
                try {
                    const second = await replace(
                        doc.id,
                        doc.versionId,
                        secondText,
                        7
                    );
                    const pending = (await version(doc.versionId)).cleanup!;
                    assert.equal(pending.status, 'PENDING');
                    assert.ok(pending.scheduledAt > new Date());
                    await replace(doc.id, second.versionId, thirdText, 365);
                    assert.deepEqual(
                        (await version(doc.versionId)).cleanup,
                        pending
                    );
                    await processDocumentCleanups(prisma);
                    assert.equal(
                        (await version(doc.versionId)).discardedAt,
                        null
                    );
                } finally {
                    await removeFixture(doc.id);
                }
            }
        );
    } finally {
        release();
        await f.owner.rag.credentials.activate({ id: storage.id });
        if (previousAllowed === undefined)
            delete process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
        else process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = previousAllowed;
        s3.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
}
