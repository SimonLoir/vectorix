import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { app } from '../app';
import { documentPdfWarningTests } from './document-pdf-warning';
import { fixture as f, readGrant } from './fixtures';
import { object } from '../user-locale-tests/http';
import {
    createPdfXrefFixture,
    pdfXrefFile,
    pdfXrefHash,
    pdfXrefPages,
    pdfXrefSources,
    pdfXrefText,
} from './document-pdf-xref-fixture';

/** Native PDF repair and rejection traverse HTTP, Poppler, private S3 and real publication; embedding vectors are synthetic. */
export async function documentPdfXrefTests(t: TestContext) {
    const environment = await createPdfXrefFixture();
    try {
        const { collection } = environment;
        const repaired = await pdfXrefFile('xref-reconstructed.pdf');
        const repairedSha = pdfXrefHash(
            new Uint8Array(await repaired.arrayBuffer())
        );
        const requestId = randomUUID();
        let generationId = '';
        let firstPublicationId = '';
        let firstReceipt = '';
        let secondVersionId = '';
        let secondPublicationId = '';
        let secondSha = '';
        const search = () =>
            f.owner.rag.indexing.search({
                collectionId: collection.id,
                query: 'PDF',
                strategy: 'LEXICAL',
                topK: 3,
                filters: {},
            });
        const uploaded = await environment.upload(repaired, requestId);
        await t.test(
            'an xref-reconstructed PDF is READY through the real parser with exact bilingual pages and authenticated original bytes',
            async () => {
                assert.deepEqual(
                    await f.owner.rag.documents.upload({
                        requestId,
                        file: repaired,
                    }),
                    uploaded
                );
                const stored = await environment.settle(uploaded.versionId);
                assert.equal(stored.status, 'READY');
                assert.equal(stored.sha256, repairedSha);
                assert.equal(stored.ingestion?.attempts, 1);
                assert.equal(stored.ingestion?.reservedBytes, 0n);
                assert.equal(stored.ingestion?.errorCode, null);
                assert.ok(stored.extraction);
                assert.equal(
                    stored.extraction.extractorVersion,
                    'pdf-structured-v1'
                );
                const artifactBytes = await environment.objectBytes(
                    stored.extraction.objectKey
                );
                assert.equal(
                    BigInt(artifactBytes.length),
                    stored.extraction.byteSize
                );
                const artifact: unknown = JSON.parse(
                    artifactBytes.toString('utf8')
                );
                assert.deepEqual(artifact, {
                    schemaVersion: 1,
                    format: 'PDF',
                    text: pdfXrefText,
                    sources: pdfXrefSources,
                    warnings: [],
                });
                assert.equal(
                    pdfXrefHash(pdfXrefText),
                    '1070ac3250f8b8649f5f2ee82c6a42accad291cc67005ac2c93583789285d0a1'
                );
                for (const [sourceIndex, text] of pdfXrefPages.entries()) {
                    const preview = await f.owner.rag.documents.sourcePreview({
                        id: uploaded.id,
                        sourceIndex,
                    });
                    assert.equal(preview.format, 'PDF');
                    assert.equal(preview.version, 1);
                    assert.equal(preview.totalSources, 2);
                    assert.deepEqual(
                        preview.source,
                        pdfXrefSources[sourceIndex]
                    );
                    assert.equal(preview.text, text);
                    assert.equal(
                        pdfXrefText.slice(
                            preview.source.start,
                            preview.source.end
                        ),
                        text
                    );
                    assert.deepEqual(preview.warnings, []);
                    assert.equal(preview.nextOffset, null);
                }
                assert.equal(
                    (await f.owner.rag.documents.preview({ id: uploaded.id }))
                        .text,
                    pdfXrefText
                );
                const download = await f.owner.rag.documents.download({
                    id: uploaded.id,
                });
                assert.equal(download.name, repaired.name);
                assert.equal(
                    pdfXrefHash(new Uint8Array(await download.arrayBuffer())),
                    repairedSha
                );
                assert.equal(
                    pdfXrefHash(
                        await environment.objectBytes(stored.objectKey)
                    ),
                    repairedSha
                );
                await f.owner.rag.documents.setCollection({
                    id: uploaded.id,
                    collectionId: collection.id,
                    attached: true,
                });
                generationId = await environment.start();
                const publication = await environment.publication(uploaded.id);
                firstPublicationId = publication.id;
                assert.equal(publication.sourceVersionId, uploaded.versionId);
                assert.equal(publication.extractionId, stored.extraction.id);
                assert.equal(publication.sourceHold?.state, 'LIVE');
                assert.equal(
                    publication.sourceHold?.versionId,
                    uploaded.versionId
                );
                const result = (await search()).results.find(
                    (item) => item.documentId === uploaded.id
                );
                assert.ok(
                    result,
                    'The repaired publication must be searchable through real PostgreSQL FTS.'
                );
                assert.equal(result.version, 1);
                firstReceipt = result.source.receipt;
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId: collection.id,
                            receipt: firstReceipt,
                            sourceIndex: 0,
                        })
                    ).text,
                    pdfXrefPages[0]
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId: collection.id,
                            receipt: firstReceipt,
                            sourceIndex: 1,
                        })
                    ).text,
                    pdfXrefPages[1]
                );
            }
        );

        await t.test(
            'repaired source reads require current collection grants and reject foreign or read-only mutation identifiers without changes',
            async () => {
                assert.ok(firstReceipt);
                for (const session of [f.reader, f.other]) {
                    await assert.rejects(
                        session.rag.documents.sourcePreview({
                            id: uploaded.id,
                        }),
                        { code: 'NOT_FOUND' }
                    );
                    await assert.rejects(
                        session.rag.documents.download({ id: uploaded.id }),
                        { code: 'NOT_FOUND' }
                    );
                }
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                const read = await f.reader.rag.documents.download({
                    id: uploaded.id,
                });
                assert.equal(
                    pdfXrefHash(new Uint8Array(await read.arrayBuffer())),
                    repairedSha
                );
                const response = await app.request(
                    `/api/v1/admin/rag/documents/${uploaded.id}/source-preview?sourceIndex=1`,
                    { headers: f.reader.headers() }
                );
                assert.equal(response.status, 200);
                assert.equal(
                    object(await response.json()).text,
                    pdfXrefPages[1]
                );
                const original = await f.reader.rag.indexing.sourceOriginal({
                    collectionId: collection.id,
                    receipt: firstReceipt,
                });
                assert.equal(
                    pdfXrefHash(new Uint8Array(await original.arrayBuffer())),
                    repairedSha
                );
                const before = await prisma.documentVersion.count({
                    where: {
                        organizationId: environment.indexing.organizationId,
                        documentId: uploaded.id,
                    },
                });
                const audits = await prisma.ragAuditLog.count({
                    where: {
                        organizationId: environment.indexing.organizationId,
                    },
                });
                const replacement = {
                    id: uploaded.id,
                    expectedVersionId: uploaded.versionId,
                    requestId: randomUUID(),
                    file: repaired,
                    retentionDays: 0,
                };
                await assert.rejects(
                    f.reader.rag.documents.replace(replacement),
                    { code: 'FORBIDDEN' }
                );
                await assert.rejects(
                    f.other.rag.documents.replace(replacement),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    f.other.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt: firstReceipt,
                    }),
                    { code: 'NOT_FOUND' }
                );
                assert.equal(
                    await prisma.documentVersion.count({
                        where: {
                            organizationId: environment.indexing.organizationId,
                            documentId: uploaded.id,
                        },
                    }),
                    before
                );
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: {
                            organizationId: environment.indexing.organizationId,
                        },
                    }),
                    audits
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: {
                        read: false,
                        manageDocuments: false,
                        administer: false,
                    },
                });
                await assert.rejects(
                    f.reader.rag.documents.sourcePreview({ id: uploaded.id }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    f.reader.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt: firstReceipt,
                    }),
                    { code: 'NOT_FOUND' }
                );
            }
        );

        await t.test(
            'a valid replacement publishes its own source version while retained repaired-original receipts block premature cleanup',
            async () => {
                assert.ok(generationId && firstPublicationId && firstReceipt);
                const valid = await pdfXrefFile('text-fr-en.pdf');
                secondSha = pdfXrefHash(
                    new Uint8Array(await valid.arrayBuffer())
                );
                assert.notEqual(secondSha, repairedSha);
                const replacement = await f.owner.rag.documents.replace({
                    id: uploaded.id,
                    expectedVersionId: uploaded.versionId,
                    requestId: randomUUID(),
                    file: valid,
                    retentionDays: 0,
                });
                secondVersionId = replacement.versionId;
                const stored = await environment.settle(secondVersionId);
                assert.equal(stored.status, 'READY');
                assert.equal(stored.version, 2);
                assert.equal(stored.sha256, secondSha);
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: uploaded.id,
                        })
                    ).version,
                    2
                );
                await environment.scan(generationId);
                const current = await environment.publication(uploaded.id);
                secondPublicationId = current.id;
                assert.notEqual(current.id, firstPublicationId);
                assert.equal(current.sourceVersionId, secondVersionId);
                assert.equal(current.extractionId, stored.extraction?.id);
                assert.equal(current.sourceHold?.state, 'LIVE');
                const first = await environment.version(uploaded.versionId);
                assert.equal(first.sha256, repairedSha);
                const hold = await prisma.documentSourceHold.findUniqueOrThrow({
                    where: { indexedDocumentId: firstPublicationId },
                });
                assert.equal(hold.state, 'RETIRED');
                assert.ok(hold.retainUntil && hold.retainUntil > new Date());
                await environment.dueCleanup(uploaded.id);
                await processDocumentCleanups(prisma);
                const retained = await environment.version(uploaded.versionId);
                assert.equal(retained.discardedAt, null);
                assert.equal(retained.contentState, 'AVAILABLE');
                assert.equal(retained.cleanup?.status, 'PENDING');
                assert.ok(await environment.objectExists(retained.objectKey));
                assert.ok(retained.extraction);
                assert.ok(
                    await environment.objectExists(
                        retained.extraction.objectKey
                    )
                );
                const original = await f.owner.rag.indexing.sourceOriginal({
                    collectionId: collection.id,
                    receipt: firstReceipt,
                });
                assert.equal(original.name, repaired.name);
                assert.equal(
                    pdfXrefHash(new Uint8Array(await original.arrayBuffer())),
                    repairedSha
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId: collection.id,
                            receipt: firstReceipt,
                        })
                    ).version,
                    1
                );
                assert.equal(
                    (await search()).results.find(
                        (item) => item.documentId === uploaded.id
                    )?.version,
                    2
                );
            }
        );

        await t.test(
            'mixed reconstruction and corruption fails safely on replacement and retry without replacing the last READY publication',
            async () => {
                assert.ok(
                    secondVersionId && secondPublicationId && generationId
                );
                const corrupt = await pdfXrefFile('xref-partial-corrupt.pdf');
                const corruptSha = pdfXrefHash(
                    new Uint8Array(await corrupt.arrayBuffer())
                );
                const failed = await f.owner.rag.documents.replace({
                    id: uploaded.id,
                    expectedVersionId: secondVersionId,
                    requestId: randomUUID(),
                    file: corrupt,
                    retentionDays: 0,
                });
                const firstFailure = await environment.settle(failed.versionId);
                assert.equal(firstFailure.status, 'FAILED');
                assert.equal(firstFailure.ingestion?.status, 'FAILED');
                assert.equal(firstFailure.ingestion?.errorCode, 'FILE_INVALID');
                assert.equal(firstFailure.ingestion?.attempts, 1);
                assert.equal(firstFailure.extraction, null);
                assert.equal(firstFailure.sha256, corruptSha);
                assert.equal(
                    await environment.objectExists(
                        `${environment.indexing.organizationId}/${uploaded.id}/${failed.versionId}/extraction.json`
                    ),
                    false
                );
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                await f.owner.rag.documents.retry({ id: uploaded.id });
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before
                );
                const retried = await environment.settle(failed.versionId);
                assert.equal(retried.status, 'FAILED');
                assert.equal(retried.ingestion?.errorCode, 'FILE_INVALID');
                assert.equal(
                    retried.ingestion?.attempts,
                    1,
                    'Explicit retry resets the attempt counter and reuses the exact durable version.'
                );
                assert.equal(
                    retried.ingestion?.reservedBytes,
                    firstFailure.ingestion?.reservedBytes
                );
                assert.equal(retried.extraction, null);
                assert.equal(
                    pdfXrefHash(
                        await environment.objectBytes(retried.objectKey)
                    ),
                    corruptSha
                );
                assert.equal(
                    await prisma.documentVersion.count({
                        where: {
                            organizationId: environment.indexing.organizationId,
                            documentId: uploaded.id,
                        },
                    }),
                    3
                );
                const lifecycle = await f.owner.rag.documents.lifecycle({
                    id: uploaded.id,
                });
                assert.equal(lifecycle.publishedVersionId, secondVersionId);
                assert.equal(lifecycle.latestVersionId, failed.versionId);
                const failure = lifecycle.versions.find(
                    (item) => item.id === failed.versionId
                );
                assert.equal(failure?.task?.diagnostic, 'FILE_INVALID');
                assert.equal(failure?.task?.errorCode, 'TEXT_INVALID');
                assert.ok(!JSON.stringify(lifecycle).includes('xref num'));
                assert.ok(
                    !JSON.stringify(lifecycle).includes('/tmp/vectorix-parser')
                );
                assert.equal(
                    (await f.owner.rag.documents.details({ id: uploaded.id }))
                        .document.status,
                    'READY'
                );
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: uploaded.id,
                            sourceIndex: 1,
                        })
                    ).text,
                    pdfXrefPages[1]
                );
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: uploaded.id,
                        })
                    ).version,
                    2
                );
                const original = await f.owner.rag.documents.download({
                    id: uploaded.id,
                });
                assert.equal(
                    pdfXrefHash(new Uint8Array(await original.arrayBuffer())),
                    secondSha
                );
                await environment.scan(generationId);
                assert.equal(
                    (await environment.publication(uploaded.id)).id,
                    secondPublicationId
                );
                const desired =
                    await prisma.generationDocument.findFirstOrThrow({
                        where: {
                            generationId,
                            documentId: uploaded.id,
                            organizationId: environment.indexing.organizationId,
                        },
                    });
                assert.equal(
                    desired.publishedIndexedDocumentId,
                    secondPublicationId
                );
                assert.equal(
                    (await search()).results.find(
                        (item) => item.documentId === uploaded.id
                    )?.version,
                    2
                );
                assert.equal(
                    (await environment.version(secondVersionId)).sha256,
                    secondSha
                );
            }
        );
        await documentPdfWarningTests(t, environment);
    } finally {
        await environment.close();
    }
}
