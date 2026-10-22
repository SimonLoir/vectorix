import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f, profile, readGrant, rpc } from './fixtures';
import { app } from '../app';

/** Real RustFS, real HTTP binary transport and the production worker processor, without provider mocks. */
export async function documentLibraryTests(t: TestContext) {
    const endpoint = process.env.VECTORIX_DEFAULT_S3_ENDPOINT!;
    assert.ok(endpoint, 'Use pnpm test:catalog to provision isolated RustFS.');
    await prisma.organizationQuota.deleteMany({
        where: { organizationId: f.org },
    });
    const storage = await f.owner.rag.credentials.create({
        name: 'Document storage',
        data: {
            provider: 'S3',
            endpoint,
            bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET!,
            region: 'us-east-1',
            forcePathStyle: true,
            accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
        },
    });
    await f.owner.rag.credentials.activate({ id: storage.id });
    const a = await f.owner.rag.collections.create({
        name: 'Documents alpha',
        profile,
    });
    const b = await f.owner.rag.collections.create({
        name: 'Documents beta',
        profile,
    });
    const foreign = await f.other.rag.collections.create({
        name: 'Documents foreign',
        profile,
    });
    const text =
        '# Bonjour — Hello\r\n<script>alert("inert")</script>\r\n' +
        'Texte français et English.\n'.repeat(1000);
    const file = new File([text], 'guide.md', { type: 'text/markdown' });
    const requestId = randomUUID();
    let doc: { id: string; versionId: string };
    const s3 = new S3Client({
        endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
            accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
        },
    });
    try {
        await t.test(
            'binary RPC upload reserves quota, remains private, extracts once, and downloads original bytes',
            async () => {
                const before = await f.owner.rag.quota({});
                doc = await f.owner.rag.documents.upload({ requestId, file });
                assert.deepEqual(
                    await f.owner.rag.documents.upload({ requestId, file }),
                    doc
                );
                await assert.rejects(
                    f.owner.rag.documents.upload({
                        requestId,
                        file: new File(['changed'], 'guide.md'),
                    }),
                    { code: 'CONFLICT' }
                );
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before.usage.storageBytes + 2 * file.size
                );
                assert.equal(
                    (await f.owner.rag.documents.details({ id: doc.id }))
                        .version?.previewAvailable,
                    false
                );
                await assert.rejects(
                    f.owner.rag.documents.setCollection({
                        id: doc.id,
                        collectionId: a.id,
                        attached: true,
                    }),
                    { code: 'CONFLICT' }
                );
                await Promise.all([
                    processDocumentIngestions(prisma),
                    processDocumentIngestions(prisma),
                ]);
                const details = await f.owner.rag.documents.details({
                    id: doc.id,
                });
                assert.equal(details.document.status, 'READY');
                assert.equal(details.version?.task?.attempts, 1);
                assert.equal(details.version?.previewAvailable, true);
                const download = await f.owner.rag.documents.download({
                    id: doc.id,
                });
                assert.ok(download instanceof File);
                assert.equal(download.name, file.name);
                assert.equal(await download.text(), text);
                const preview = await f.owner.rag.documents.preview({
                    id: doc.id,
                    offset: 0,
                });
                assert.equal(
                    preview.text,
                    text.replaceAll('\r\n', '\n').slice(0, 20_000)
                );
                assert.equal(preview.nextOffset, 20_000);
                const tail = await f.owner.rag.documents.preview({
                    id: doc.id,
                    offset: preview.nextOffset!,
                });
                assert.equal(
                    preview.text + tail.text,
                    text.replaceAll('\r\n', '\n')
                );
                const version = await prisma.documentVersion.findUniqueOrThrow({
                    where: { id: doc.versionId },
                    include: { extraction: true },
                });
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before.usage.storageBytes +
                        file.size +
                        Number(version.extraction?.byteSize)
                );
                assert.equal(
                    (
                        await fetch(
                            `${endpoint}/${process.env.VECTORIX_DEFAULT_S3_BUCKET}/${version.objectKey}`
                        )
                    ).status,
                    403
                );
                assert.ok(!JSON.stringify(details).includes('objectKey'));
                assert.ok(!JSON.stringify(details).includes('secretAccessKey'));
                await processDocumentIngestions(prisma);
                assert.equal(
                    await prisma.documentExtraction.count({
                        where: { versionId: doc.versionId },
                    }),
                    1
                );
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: {
                            targetId: doc.id,
                            action: 'document.extraction.ready',
                        },
                    }),
                    1
                );
            }
        );
        await t.test(
            'collection links enforce membership, cross-organization boundaries, scopes, and immediate revocation',
            async () => {
                for (const action of [
                    'details',
                    'preview',
                    'download',
                ] as const) {
                    await assert.rejects(
                        f.other.rag.documents[action]({ id: doc.id }),
                        { code: 'NOT_FOUND' }
                    );
                    await assert.rejects(
                        f.reader.rag.documents[action]({ id: doc.id }),
                        { code: 'NOT_FOUND' }
                    );
                }
                await assert.rejects(
                    f.reader.rag.documents.upload({
                        requestId: randomUUID(),
                        file,
                    }),
                    { code: 'FORBIDDEN' }
                );
                await assert.rejects(
                    f.owner.rag.documents.setCollection({
                        id: doc.id,
                        collectionId: foreign.id,
                        attached: true,
                    }),
                    { code: 'NOT_FOUND' }
                );
                for (const collectionId of [a.id, b.id])
                    await f.owner.rag.documents.setCollection({
                        id: doc.id,
                        collectionId,
                        attached: true,
                    });
                await f.owner.rag.collections.setGrant({
                    id: a.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                assert.equal(
                    (await f.reader.rag.documents.download({ id: doc.id }))
                        .name,
                    file.name
                );
                assert.equal(
                    (await f.reader.rag.documents.details({ id: doc.id }))
                        .canManage,
                    false
                );
                assert.equal(
                    (
                        await f.manager.rag.documents.collectionCandidates({
                            id: doc.id,
                            query: 'Documents alpha',
                        })
                    ).total,
                    0
                );
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Document read',
                        permissions: {
                            ragLibrary: ['read'],
                            ragCollection: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId: a.id,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key }));
                assert.equal(
                    (await api.admin.rag.documents.download({ id: doc.id }))
                        .name,
                    file.name
                );
                await assert.rejects(
                    api.admin.rag.documents.retry({ id: doc.id }),
                    { code: 'FORBIDDEN' }
                );
                await f.owner.rag.documents.setCollection({
                    id: doc.id,
                    collectionId: a.id,
                    attached: false,
                });
                await assert.rejects(
                    f.reader.rag.documents.download({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    api.admin.rag.documents.preview({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                assert.equal(
                    (await f.owner.rag.documents.details({ id: doc.id }))
                        .document.status,
                    'READY'
                );
            }
        );
        await t.test(
            'REST multipart upload and binary download use the same public contract and platform fallback',
            async () => {
                const form = new FormData();
                form.set('requestId', randomUUID());
                form.set(
                    'file',
                    new File(['Hello from REST\n'], 'rest.txt', {
                        type: 'text/plain',
                    })
                );
                const uploaded = await app.request(
                    '/api/v1/admin/rag/documents/uploads',
                    { method: 'POST', headers: f.other.headers(), body: form }
                );
                assert.equal(
                    uploaded.status,
                    200,
                    await uploaded.clone().text()
                );
                const result = await uploaded.json();
                await processDocumentIngestions(prisma);
                const response = await app.request(
                    `/api/v1/admin/rag/documents/${result.id}/original`,
                    { headers: f.other.headers() }
                );
                assert.equal(response.status, 200);
                assert.equal(await response.text(), 'Hello from REST\n');
                assert.match(
                    response.headers.get('content-disposition') ?? '',
                    /rest.txt/
                );
                assert.equal(
                    response.headers.get('Vectorix-API-Revision'),
                    '13'
                );
            }
        );
        await t.test(
            'invalid UTF-8 is a sanitized terminal failure, retries reuse reservations, and unknown extensions fail before writes',
            async () => {
                const invalid = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(
                        [new Uint8Array([0xff, 0xfe, 0x00])],
                        'bad.txt'
                    ),
                });
                await processDocumentIngestions(prisma);
                const result = await f.owner.rag.documents.details({
                    id: invalid.id,
                });
                assert.equal(result.version?.task?.errorCode, 'TEXT_INVALID');
                assert.equal(result.version?.previewAvailable, false);
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                await f.owner.rag.documents.retry({ id: invalid.id });
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before
                );
                await processDocumentIngestions(prisma);
                await assert.rejects(
                    f.owner.rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File(['pdf'], 'file.rtf'),
                    }),
                    { code: 'BAD_REQUEST' }
                );
                await assert.rejects(
                    f.owner.rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File([], 'empty.txt'),
                    }),
                    { code: 'BAD_REQUEST' }
                );
            }
        );
        await t.test(
            'expired upload and worker leases recover durable state, absent originals release reservations',
            async () => {
                const recovered = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(['Recovered'], 'recover.txt'),
                });
                await prisma.documentVersion.update({
                    where: { id: recovered.versionId },
                    data: { storedAt: null },
                });
                await prisma.documentIngestion.update({
                    where: { versionId: recovered.versionId },
                    data: {
                        status: 'UPLOADING',
                        leasedUntil: new Date(0),
                        leaseToken: randomUUID(),
                    },
                });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (await f.owner.rag.documents.details({ id: recovered.id }))
                        .document.status,
                    'READY'
                );
                const missing = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(['Missing'], 'missing.txt'),
                });
                const version = await prisma.documentVersion.findUniqueOrThrow({
                    where: { id: missing.versionId },
                });
                await s3.send(
                    new DeleteObjectCommand({
                        Bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET,
                        Key: version.objectKey,
                    })
                );
                await prisma.documentVersion.update({
                    where: { id: missing.versionId },
                    data: { storedAt: null },
                });
                await prisma.documentIngestion.update({
                    where: { versionId: missing.versionId },
                    data: {
                        status: 'UPLOADING',
                        leasedUntil: new Date(0),
                        leaseToken: randomUUID(),
                    },
                });
                await processDocumentIngestions(prisma);
                const details = await f.owner.rag.documents.details({
                    id: missing.id,
                });
                assert.equal(
                    details.version?.task?.errorCode,
                    'UPLOAD_INCOMPLETE'
                );
                assert.equal(details.version?.retryable, false);
                assert.equal(
                    (
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: { versionId: missing.versionId },
                        })
                    ).reservedBytes,
                    0n
                );
                await assert.rejects(
                    f.owner.rag.documents.retry({ id: missing.id }),
                    { code: 'CONFLICT' }
                );
            }
        );
        await t.test(
            'worker rechecks organization access, while current managers can retry after restoration',
            async () => {
                const blocked = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(
                        ['Check current organization'],
                        'access.txt'
                    ),
                });
                await prisma.organization.update({
                    where: { id: f.org },
                    data: { isActive: false },
                });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: { versionId: blocked.versionId },
                        })
                    ).errorCode,
                    'ACCESS_REVOKED'
                );
                await prisma.organization.update({
                    where: { id: f.org },
                    data: { isActive: true },
                });
                await f.owner.rag.documents.retry({ id: blocked.id });
                await processDocumentIngestions(prisma);
                assert.equal(
                    (await f.owner.rag.documents.details({ id: blocked.id }))
                        .document.status,
                    'READY'
                );
            }
        );
        await t.test(
            'concurrent uploads cannot overspend quota or leave partial catalog writes',
            async () => {
                const current = await f.owner.rag.quota({});
                await f.owner.client.superadmin.organizations.setRagQuota({
                    organizationId: f.org,
                    limits: {
                        ...current.limits,
                        documents: current.usage.documents + 1,
                    },
                });
                const before = await prisma.document.count({
                    where: { organizationId: f.org },
                });
                const results = await Promise.allSettled(
                    [1, 2].map((i) =>
                        f.owner.rag.documents.upload({
                            requestId: randomUUID(),
                            file: new File(['quota'], `quota-${i}.txt`),
                        })
                    )
                );
                assert.equal(
                    results.filter((r) => r.status === 'fulfilled').length,
                    1
                );
                assert.equal(
                    await prisma.document.count({
                        where: { organizationId: f.org },
                    }),
                    before + 1
                );
                await prisma.organizationQuota.deleteMany({
                    where: { organizationId: f.org },
                });
                await processDocumentIngestions(prisma);
            }
        );
        await t.test(
            'expired processing leases and temporary S3 authentication failures remain recoverable',
            async () => {
                const job = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(['Recover worker lease'], 'lease.txt'),
                });
                await prisma.documentIngestion.update({
                    where: { versionId: job.versionId },
                    data: {
                        status: 'PROCESSING',
                        attempts: 1,
                        leasedUntil: new Date(0),
                        leaseToken: randomUUID(),
                    },
                });
                const broken = await f.owner.rag.credentials.update({
                    id: storage.id,
                    name: storage.name,
                    expectedRevision: storage.revision,
                    data: {
                        provider: 'S3',
                        endpoint,
                        bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET!,
                        region: 'us-east-1',
                        forcePathStyle: true,
                        secretAccessKey: 'invalid-storage-test-secret',
                    },
                });
                await processDocumentIngestions(prisma);
                const pending =
                    await prisma.documentIngestion.findUniqueOrThrow({
                        where: { versionId: job.versionId },
                    });
                assert.equal(pending.status, 'PENDING');
                assert.equal(pending.errorCode, 'STORAGE_UNAVAILABLE');
                assert.ok(pending.reservedBytes > 0n);
                assert.ok(pending.availableAt > new Date());
                await f.owner.rag.credentials.update({
                    id: storage.id,
                    name: storage.name,
                    expectedRevision: broken.revision,
                    data: {
                        provider: 'S3',
                        endpoint,
                        bucket: process.env.VECTORIX_DEFAULT_S3_BUCKET!,
                        region: 'us-east-1',
                        forcePathStyle: true,
                        secretAccessKey:
                            process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
                    },
                });
                await prisma.documentIngestion.update({
                    where: { versionId: job.versionId },
                    data: { availableAt: new Date(0) },
                });
                await Promise.all([
                    processDocumentIngestions(prisma),
                    processDocumentIngestions(prisma),
                ]);
                assert.equal(
                    (await f.owner.rag.documents.details({ id: job.id }))
                        .document.status,
                    'READY'
                );
                assert.equal(
                    await prisma.documentExtraction.count({
                        where: { versionId: job.versionId },
                    }),
                    1
                );
            }
        );
        await t.test(
            'invalid configured S3 credentials do not fall back and retained originals keep their saved destination',
            async () => {
                const otherStorage = await f.owner.rag.credentials.create({
                    name: 'Unavailable storage',
                    data: {
                        provider: 'S3',
                        endpoint: 'http://127.0.0.1:9',
                        bucket: 'forbidden',
                        region: 'us-east-1',
                        forcePathStyle: true,
                        accessKeyId: 'unused',
                        secretAccessKey: 'unused',
                    },
                });
                await f.owner.rag.credentials.activate({ id: otherStorage.id });
                const before = await prisma.document.count({
                    where: { organizationId: f.org },
                });
                await assert.rejects(
                    f.owner.rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File(['no fallback'], 'forbidden.txt'),
                    })
                );
                assert.equal(
                    await prisma.document.count({
                        where: { organizationId: f.org },
                    }),
                    before
                );
                assert.equal(
                    await (
                        await f.owner.rag.documents.download({ id: doc.id })
                    ).text(),
                    text
                );
                await f.owner.rag.credentials.activate({ id: storage.id });
            }
        );
    } finally {
        s3.destroy();
    }
}
