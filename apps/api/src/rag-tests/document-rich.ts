import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { TestContext } from 'node:test';
import {
    S3Client,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { parseRichDocument } from '../../../workers/src/extraction/main';
import { fixture as f, profile, readGrant, rpc } from './fixtures';
import { app } from '../app';

const RICH_RESERVATION_BYTES = 10 * 1024 * 1024;
const pdfPages = [
    'English source - page one.\nVectorix preserves PDF page references.',
    'Bonjour équipe - page deux.\nTexte français : été, élève et façade.',
];
const docxParagraphs = [
    'Guide français',
    'Bonjour équipe. English paragraph.\tAprès tabulation.\nSecond line.',
    'End of section one.',
    'English section',
    'Visible text. Inserted text.',
    'Cellule française',
    'English table cell',
];

/** Real PDF/OOXML bytes pass through the production worker parser and private RustFS, then RPC/REST source reads. */
export async function documentRichTests(t: TestContext) {
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
        name: 'Rich document storage',
        data,
    });
    await f.owner.rag.credentials.activate({ id: storage.id });
    const s3 = new S3Client({
        ...data,
        credentials: {
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
        },
    });
    const created: string[] = [];
    const ready = new Map<string, { id: string; versionId: string }>();
    const run = randomUUID();
    async function file(name: string) {
        const bytes = await readFile(
            new URL(
                `../../../../tests/documents/fixtures/${name}`,
                import.meta.url
            )
        );
        // The client MIME is deliberately misleading: trusted format selection uses the filename and verified bytes.
        return new File([new Uint8Array(bytes)], name, { type: 'text/plain' });
    }
    function version(id: string) {
        return prisma.documentVersion.findUniqueOrThrow({
            where: { id },
            include: { ingestion: true, extraction: true, cleanup: true },
        });
    }
    async function upload(name: string) {
        const result = await f.owner.rag.documents.upload({
            requestId: randomUUID(),
            file: await file(name),
        });
        created.push(result.id);
        return result;
    }
    async function settle(versionId: string) {
        for (let attempt = 0; attempt < 5; attempt++) {
            await processDocumentIngestions(prisma, parseRichDocument);
            const task = (await version(versionId)).ingestion!;
            if (task.status === 'READY' || task.status === 'FAILED')
                return task;
        }
        assert.fail('The isolated rich-document fixture did not settle.');
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
    /** Advance only this test's durable retirement deadlines, including the external-write grace, without sleeping. */
    async function clean(documentId: string) {
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
                scheduledAt: new Date(0),
                availableAt: new Date(0),
                leasedUntil: new Date(0),
            },
        });
        for (let attempt = 0; attempt < 10; attempt++) {
            await processDocumentCleanups(prisma);
            if (
                !(await prisma.documentCleanup.count({
                    where: {
                        organizationId: f.org,
                        version: { documentId },
                        status: { not: 'COMPLETE' },
                    },
                }))
            )
                return;
        }
        assert.fail('The isolated rich-document cleanup did not finish.');
    }
    try {
        await t.test(
            'prototype property names and missing extensions are rejected before catalog writes',
            async () => {
                const before = await prisma.document.count({
                    where: { organizationId: f.org },
                });
                for (const name of [
                    'payload.constructor',
                    'payload.__proto__',
                    'payload.toString',
                    'README',
                ])
                    await assert.rejects(
                        f.owner.rag.documents.upload({
                            requestId: randomUUID(),
                            file: new File(['Untrusted extension'], name),
                        }),
                        { code: 'BAD_REQUEST' }
                    );
                assert.equal(
                    await prisma.document.count({
                        where: { organizationId: f.org },
                    }),
                    before
                );
            }
        );
        for (const [name, format, texts] of [
            ['text-fr-en.pdf', 'PDF', pdfPages],
            ['structure-fr-en.docx', 'DOCX', docxParagraphs],
        ] as const) {
            await t.test(
                `${format} reserves bounded expansion, publishes one private structured artifact and preserves original/source positions`,
                async () => {
                    const original = await file(name);
                    const before = (await f.owner.rag.quota({})).usage
                        .storageBytes;
                    const requestId = randomUUID();
                    const doc = await f.owner.rag.documents.upload({
                        requestId,
                        file: original,
                    });
                    created.push(doc.id);
                    ready.set(format, doc);
                    assert.deepEqual(
                        await f.owner.rag.documents.upload({
                            requestId,
                            file: original,
                        }),
                        doc
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before + original.size + RICH_RESERVATION_BYTES
                    );
                    assert.equal(
                        (await version(doc.versionId)).ingestion?.reservedBytes,
                        BigInt(RICH_RESERVATION_BYTES)
                    );
                    await Promise.all([
                        processDocumentIngestions(prisma, parseRichDocument),
                        processDocumentIngestions(prisma, parseRichDocument),
                    ]);
                    const stored = await version(doc.versionId);
                    assert.equal(stored.status, 'READY');
                    assert.equal(stored.ingestion?.attempts, 1);
                    assert.equal(stored.ingestion?.reservedBytes, 0n);
                    assert.ok(stored.extraction);
                    assert.equal(
                        stored.extraction.extractorVersion,
                        `${format.toLowerCase()}-structured-v1`
                    );
                    assert.match(
                        stored.extraction.objectKey,
                        /\/extraction\.json$/
                    );
                    const artifactResponse = await s3.send(
                        new GetObjectCommand({
                            Bucket: bucket,
                            Key: stored.extraction.objectKey,
                        })
                    );
                    assert.equal(
                        artifactResponse.ContentType,
                        'application/json; charset=utf-8'
                    );
                    const artifact = JSON.parse(
                        (await artifactResponse.Body?.transformToString())!
                    );
                    assert.equal(artifact.schemaVersion, 1);
                    assert.equal(artifact.format, format);
                    assert.equal(artifact.text, texts.join('\n\n'));
                    assert.equal(artifact.sources.length, texts.length);
                    for (const [index, text] of texts.entries()) {
                        const preview =
                            await f.owner.rag.documents.sourcePreview({
                                id: doc.id,
                                sourceIndex: index,
                            });
                        assert.equal(preview.format, format);
                        assert.equal(preview.totalSources, texts.length);
                        assert.equal(preview.text, text);
                        assert.equal(preview.source.index, index);
                        assert.equal(preview.version, 1);
                        assert.equal(preview.nextOffset, null);
                        assert.deepEqual(preview.warnings, []);
                        assert.equal(
                            artifact.text.slice(
                                preview.source.start,
                                preview.source.end
                            ),
                            text
                        );
                        if (format === 'PDF') {
                            assert.equal(preview.source.kind, 'pdf-page');
                            assert.equal(preview.source.page, index + 1);
                        } else {
                            assert.equal(preview.source.kind, 'docx-paragraph');
                            assert.equal(preview.source.paragraph, index + 1);
                            assert.equal(
                                preview.source.section,
                                index < 3 ? 1 : 2
                            );
                            assert.equal(
                                preview.source.heading,
                                index < 3 ? 'Guide français' : 'English section'
                            );
                        }
                    }
                    assert.equal(
                        (await f.owner.rag.documents.preview({ id: doc.id }))
                            .text,
                        artifact.text
                    );
                    assert.ok(!artifact.text.includes('DELETED SECRET'));
                    assert.ok(!artifact.text.includes('INSTRUCTION SECRET'));
                    const download = await f.owner.rag.documents.download({
                        id: doc.id,
                    });
                    assert.deepEqual(
                        await download.arrayBuffer(),
                        await original.arrayBuffer()
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before +
                            original.size +
                            Number(stored.extraction.byteSize)
                    );
                    assert.equal(
                        (
                            await fetch(
                                `${endpoint}/${bucket}/${stored.extraction.objectKey}`
                            )
                        ).status,
                        403
                    );
                    await assert.rejects(
                        f.owner.rag.documents.sourcePreview({
                            id: doc.id,
                            sourceIndex: texts.length,
                        }),
                        { code: 'BAD_REQUEST' }
                    );
                    await assert.rejects(
                        f.owner.rag.documents.sourcePreview({
                            id: doc.id,
                            offset: texts[0]!.length + 1,
                        }),
                        { code: 'BAD_REQUEST' }
                    );
                    await processDocumentIngestions(prisma, parseRichDocument);
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
        }
        await t.test(
            'DOCX body, headers, footers and notes preserve exact part-local citations while omitting comments and separators',
            async () => {
                const doc = await upload('stories.docx');
                assert.equal((await settle(doc.versionId)).status, 'READY');
                const expected = [
                    {
                        part: 'body',
                        partIndex: 1,
                        paragraph: 1,
                        section: 1,
                        text: 'Main body — corps principal.',
                    },
                    {
                        part: 'body',
                        partIndex: 1,
                        paragraph: 2,
                        section: 1,
                        text: '',
                    },
                    {
                        part: 'endnote',
                        partIndex: 2,
                        paragraph: 1,
                        text: 'English endnote.',
                    },
                    {
                        part: 'footer',
                        partIndex: 3,
                        paragraph: 1,
                        text: 'English footer.',
                    },
                    {
                        part: 'footnote',
                        partIndex: 4,
                        paragraph: 1,
                        text: 'Note de bas de page française.',
                    },
                    {
                        part: 'header',
                        partIndex: 5,
                        paragraph: 1,
                        text: 'En-tête français.',
                    },
                ];
                for (const [index, source] of expected.entries()) {
                    const preview = await f.owner.rag.documents.sourcePreview({
                        id: doc.id,
                        sourceIndex: index,
                    });
                    assert.equal(preview.format, 'DOCX');
                    assert.equal(preview.totalSources, 6);
                    assert.equal(preview.text, source.text);
                    assert.equal(preview.source.part, source.part);
                    assert.equal(preview.source.partIndex, source.partIndex);
                    assert.equal(preview.source.paragraph, source.paragraph);
                    assert.equal(preview.source.section, source.section);
                    assert.deepEqual(
                        preview.warnings,
                        index === 1 ? [{ code: 'NO_TEXT', sourceIndex: 1 }] : []
                    );
                }
                const preview = await f.owner.rag.documents.preview({
                    id: doc.id,
                });
                assert.equal(
                    preview.text,
                    expected.map((source) => source.text).join('\n\n')
                );
                for (const excluded of [
                    'OMIT FOOTNOTE',
                    'OMIT ENDNOTE',
                    'OMIT COMMENT',
                ])
                    assert.ok(!preview.text.includes(excluded));
            }
        );
        await t.test(
            'DOCX citations include only live current references and exclude orphan, historical and deleted content',
            async () => {
                const doc = await upload('live-references.docx');
                assert.equal((await settle(doc.versionId)).status, 'READY');
                const expected = [
                    {
                        part: 'body',
                        partIndex: 1,
                        paragraph: 1,
                        section: 1,
                        text: 'Current main text.',
                    },
                    {
                        part: 'body',
                        partIndex: 1,
                        paragraph: 2,
                        section: 1,
                        text: '',
                    },
                    {
                        part: 'body',
                        partIndex: 1,
                        paragraph: 3,
                        section: 1,
                        text: 'Current section remains visible.',
                    },
                    {
                        part: 'endnote',
                        partIndex: 2,
                        paragraph: 1,
                        text: 'Current endnote.',
                    },
                    {
                        part: 'footer',
                        partIndex: 3,
                        paragraph: 1,
                        text: 'Current footer.',
                    },
                    {
                        part: 'footnote',
                        partIndex: 4,
                        paragraph: 1,
                        text: 'Current footnote.',
                    },
                    {
                        part: 'footnote',
                        partIndex: 4,
                        paragraph: 2,
                        text: 'Header footnote.',
                    },
                    {
                        part: 'header',
                        partIndex: 5,
                        paragraph: 1,
                        text: 'Current header.',
                    },
                    { part: 'header', partIndex: 5, paragraph: 2, text: '' },
                ];
                for (const [index, source] of expected.entries()) {
                    const preview = await f.owner.rag.documents.sourcePreview({
                        id: doc.id,
                        sourceIndex: index,
                    });
                    assert.equal(preview.totalSources, expected.length);
                    assert.equal(preview.source.index, index);
                    assert.equal(preview.source.part, source.part);
                    assert.equal(preview.source.partIndex, source.partIndex);
                    assert.equal(preview.source.paragraph, source.paragraph);
                    assert.equal(preview.source.section, source.section);
                    assert.equal(preview.text, source.text);
                    assert.deepEqual(
                        preview.warnings,
                        index === 1 || index === 8
                            ? [{ code: 'NO_TEXT', sourceIndex: index }]
                            : []
                    );
                }
                const preview = await f.owner.rag.documents.preview({
                    id: doc.id,
                });
                assert.equal(
                    preview.text,
                    expected.map((source) => source.text).join('\n\n')
                );
                for (const excluded of [
                    'ORPHAN HEADER SECRET',
                    'ORPHAN FOOTER SECRET',
                    'ORPHAN FOOTNOTE SECRET',
                    'ORPHAN ENDNOTE SECRET',
                    'HISTORICAL HEADER SECRET',
                    'DELETED HEADER REFERENCE',
                    'DELETED FOOTNOTE REFERENCE',
                    'DELETED ENDNOTE REFERENCE',
                    'DELETED BODY SECRET',
                ])
                    assert.ok(
                        !preview.text.includes(excluded),
                        `Inactive Word content leaked: ${excluded}`
                    );
                await assert.rejects(
                    f.owner.rag.documents.sourcePreview({
                        id: doc.id,
                        sourceIndex: expected.length,
                    }),
                    { code: 'BAD_REQUEST' }
                );
            }
        );
        await t.test(
            'DOCX display text is extracted without dereferencing or exposing hyperlink target URLs',
            async () => {
                const doc = await upload('hyperlinks.docx');
                assert.equal((await settle(doc.versionId)).status, 'READY');
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .text,
                    'Open the English source.'
                );
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: doc.id,
                            sourceIndex: 1,
                        })
                    ).text,
                    'Lien français et adresse email.'
                );
                const preview = await f.owner.rag.documents.preview({
                    id: doc.id,
                });
                for (const excluded of [
                    'never-dereference',
                    'example.invalid',
                    '127.0.0.1',
                ])
                    assert.ok(!preview.text.includes(excluded));
            }
        );
        await t.test(
            'source RPC/REST enforce current collection grants, key scopes and organization isolation',
            async () => {
                const doc = ready.get('PDF')!;
                for (const session of [f.reader, f.other])
                    await assert.rejects(
                        session.rag.documents.sourcePreview({ id: doc.id }),
                        { code: 'NOT_FOUND' }
                    );
                const collection = await f.owner.rag.collections.create({
                    name: `${run}-sources`,
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
                assert.equal(
                    (
                        await f.reader.rag.documents.sourcePreview({
                            id: doc.id,
                            sourceIndex: 1,
                        })
                    ).text,
                    pdfPages[1]
                );
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Rich source read',
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
                    (
                        await api.admin.rag.documents.sourcePreview({
                            id: doc.id,
                        })
                    ).text,
                    pdfPages[0]
                );
                const rest = await app.request(
                    `/api/v1/admin/rag/documents/${doc.id}/source-preview?sourceIndex=1&offset=0`,
                    { headers: f.owner.headers() }
                );
                assert.equal(rest.status, 200, await rest.clone().text());
                assert.equal(rest.headers.get('Vectorix-API-Revision'), '9');
                assert.equal((await rest.json()).text, pdfPages[1]);
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: {
                        read: false,
                        administer: false,
                        manageDocuments: false,
                    },
                });
                await assert.rejects(
                    f.reader.rag.documents.sourcePreview({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                await f.owner.rag.documents.setCollection({
                    id: doc.id,
                    collectionId: collection.id,
                    attached: false,
                });
                await assert.rejects(
                    api.admin.rag.documents.sourcePreview({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .text,
                    pdfPages[0]
                );
            }
        );
        await t.test(
            'partially textless PDFs preserve empty page references with an explicit warning',
            async () => {
                const doc = await upload('mixed.pdf');
                assert.equal((await settle(doc.versionId)).status, 'READY');
                const page = await f.owner.rag.documents.sourcePreview({
                    id: doc.id,
                    sourceIndex: 1,
                });
                assert.equal(page.totalSources, 2);
                assert.equal(page.source.page, 2);
                assert.equal(page.text, '');
                assert.deepEqual(page.warnings, [
                    { code: 'NO_TEXT', sourceIndex: 1 },
                ]);
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .text,
                    pdfPages[0]
                );
            }
        );
        for (const [name, diagnostic, errorCode] of [
            ['scanned.pdf', 'PDF_OCR_UNAVAILABLE', 'TEXT_EMPTY'],
            ['encrypted.pdf', 'PDF_ENCRYPTED', 'TEXT_INVALID'],
            ['corrupt.pdf', 'FILE_INVALID', 'TEXT_INVALID'],
            ['malformed.docx', 'FILE_INVALID', 'TEXT_INVALID'],
            ['zipbomb.docx', 'PARSER_LIMIT', 'PROCESSING_FAILED'],
        ] as const) {
            await t.test(
                `${name} has a sanitized terminal diagnostic and keeps legacy V1 error compatibility`,
                async () => {
                    const doc = await upload(name);
                    const task = await settle(doc.versionId);
                    assert.equal(task.status, 'FAILED');
                    assert.equal(task.errorCode, diagnostic);
                    const details = await f.owner.rag.documents.details({
                        id: doc.id,
                    });
                    assert.equal(details.document.status, 'FAILED');
                    assert.equal(details.version?.task?.errorCode, errorCode);
                    assert.equal(details.version?.task?.diagnostic, diagnostic);
                    assert.equal(details.version?.previewAvailable, false);
                    assert.equal(
                        (await version(doc.versionId)).extraction,
                        null
                    );
                    await assert.rejects(
                        f.owner.rag.documents.sourcePreview({ id: doc.id }),
                        { code: 'CONFLICT' }
                    );
                    assert.ok(!JSON.stringify(details).includes('objectKey'));
                    assert.ok(!JSON.stringify(details).includes('/tmp/'));
                }
            );
        }
        await t.test(
            'missing parser remains retryable and a restarted worker can process the saved original',
            async () => {
                const doc = await upload('text-fr-en.pdf');
                await processDocumentIngestions(prisma);
                const task = (await version(doc.versionId)).ingestion!;
                assert.equal(task.status, 'PENDING');
                assert.equal(task.errorCode, 'PARSER_UNAVAILABLE');
                assert.equal(
                    task.reservedBytes,
                    BigInt(RICH_RESERVATION_BYTES)
                );
                const details = await f.owner.rag.documents.details({
                    id: doc.id,
                });
                assert.equal(
                    details.version?.task?.errorCode,
                    'PROCESSING_FAILED'
                );
                assert.equal(
                    details.version?.task?.diagnostic,
                    'PARSER_UNAVAILABLE'
                );
                await prisma.documentIngestion.update({
                    where: { versionId: doc.versionId },
                    data: { availableAt: new Date(0) },
                });
                assert.equal((await settle(doc.versionId)).status, 'READY');
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: doc.id,
                            sourceIndex: 1,
                        })
                    ).text,
                    pdfPages[1]
                );
            }
        );
        await t.test(
            'source pagination preserves Unicode boundaries for existing plain-text extractions',
            async () => {
                const text = 'A'.repeat(19_999) + '😀' + 'B'.repeat(21_000);
                const doc = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File([text], `${run}-unicode.txt`),
                });
                created.push(doc.id);
                assert.equal((await settle(doc.versionId)).status, 'READY');
                const first = await f.owner.rag.documents.sourcePreview({
                    id: doc.id,
                });
                assert.equal(first.format, 'TEXT');
                assert.equal(first.totalSources, 1);
                assert.equal(first.nextOffset, 19_999);
                assert.equal(first.text, text.slice(0, 19_999));
                await assert.rejects(
                    f.owner.rag.documents.sourcePreview({
                        id: doc.id,
                        offset: 20_000,
                    }),
                    { code: 'BAD_REQUEST' }
                );
                const second = await f.owner.rag.documents.sourcePreview({
                    id: doc.id,
                    offset: first.nextOffset!,
                });
                const third = await f.owner.rag.documents.sourcePreview({
                    id: doc.id,
                    offset: second.nextOffset!,
                });
                assert.equal(first.text + second.text + third.text, text);
                assert.equal(third.nextOffset, null);
            }
        );
        await t.test(
            'rich-document reservations prevent concurrent quota overspend before any second catalog write',
            async () => {
                const original = await file('structure-fr-en.docx');
                const before = await f.owner.rag.quota({});
                await f.owner.client.superadmin.organizations.setRagQuota({
                    organizationId: f.org,
                    limits: {
                        ...before.limits,
                        storageBytes:
                            before.usage.storageBytes +
                            original.size +
                            RICH_RESERVATION_BYTES,
                    },
                });
                try {
                    const result = await Promise.allSettled(
                        [1, 2].map(() =>
                            f.owner.rag.documents.upload({
                                requestId: randomUUID(),
                                file: original,
                            })
                        )
                    );
                    const accepted = result.filter(
                        (item) => item.status === 'fulfilled'
                    );
                    assert.equal(accepted.length, 1);
                    assert.equal(
                        result.filter((item) => item.status === 'rejected')
                            .length,
                        1
                    );
                    const doc = accepted[0]!.value;
                    created.push(doc.id);
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before.usage.storageBytes +
                            original.size +
                            RICH_RESERVATION_BYTES
                    );
                    assert.equal((await settle(doc.versionId)).status, 'READY');
                } finally {
                    await prisma.organizationQuota.deleteMany({
                        where: { organizationId: f.org },
                    });
                }
            }
        );
        await t.test(
            'failed rich replacements retain the published source, retries reuse quota, and deletion cleans JSON artifacts including unpublished writes',
            async () => {
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                const doc = await upload('text-fr-en.pdf');
                assert.equal((await settle(doc.versionId)).status, 'READY');
                const failed = await f.owner.rag.documents.replace({
                    id: doc.id,
                    expectedVersionId: doc.versionId,
                    requestId: randomUUID(),
                    file: await file('scanned.pdf'),
                    retentionDays: 0,
                });
                assert.equal((await settle(failed.versionId)).status, 'FAILED');
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .version,
                    1
                );
                const reserved = (await f.owner.rag.quota({})).usage
                    .storageBytes;
                await f.owner.rag.documents.retry({ id: doc.id });
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    reserved
                );
                assert.equal((await settle(failed.versionId)).status, 'FAILED');
                const failure = await f.owner.rag.documents.lifecycle({
                    id: doc.id,
                });
                assert.equal(
                    failure.versions[0]?.task?.diagnostic,
                    'PDF_OCR_UNAVAILABLE'
                );
                assert.equal(failure.publishedVersionId, doc.versionId);
                const replacement = await f.owner.rag.documents.replace({
                    id: doc.id,
                    expectedVersionId: failed.versionId,
                    requestId: randomUUID(),
                    file: await file('structure-fr-en.docx'),
                    retentionDays: 0,
                });
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .version,
                    1
                );
                assert.equal(
                    (await settle(replacement.versionId)).status,
                    'READY'
                );
                assert.equal(
                    (
                        await f.owner.rag.documents.sourcePreview({
                            id: doc.id,
                            sourceIndex: 3,
                        })
                    ).source.section,
                    2
                );
                assert.equal(
                    (await f.owner.rag.documents.sourcePreview({ id: doc.id }))
                        .version,
                    3
                );
                const oldVersion = await version(doc.versionId);
                const newVersion = await version(replacement.versionId);
                const failedVersion = await version(failed.versionId);
                const orphanKey = `${f.org}/${doc.id}/${failed.versionId}/extraction.json`;
                // Reproduce an object PUT whose response/publication was lost: cleanup must not depend on extraction metadata.
                await s3.send(
                    new PutObjectCommand({
                        Bucket: bucket,
                        Key: orphanKey,
                        Body: '{"orphan":true}',
                        ContentType: 'application/json',
                    })
                );
                assert.equal(failedVersion.extraction, null);
                assert.equal(await objectExists(orphanKey), true);
                await clean(doc.id);
                assert.equal(await objectExists(oldVersion.objectKey), false);
                assert.equal(
                    await objectExists(oldVersion.extraction!.objectKey),
                    false
                );
                assert.equal(await objectExists(orphanKey), false);
                assert.equal(
                    await objectExists(newVersion.extraction!.objectKey),
                    true
                );
                await f.owner.rag.documents.delete({
                    id: doc.id,
                    expectedVersionId: replacement.versionId,
                    retentionDays: 0,
                });
                await assert.rejects(
                    f.owner.rag.documents.sourcePreview({ id: doc.id }),
                    { code: 'NOT_FOUND' }
                );
                await clean(doc.id);
                assert.equal(await objectExists(newVersion.objectKey), false);
                assert.equal(
                    await objectExists(newVersion.extraction!.objectKey),
                    false
                );
                assert.equal(
                    (await f.owner.rag.quota({})).usage.storageBytes,
                    before
                );
            }
        );
        await t.test(
            'a delayed JSON PUT reopens completed cleanup, restores the rich reservation and never republishes deleted content',
            async () => {
                let release!: () => void;
                let arrived!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const held = new Promise<void>((resolve) => {
                    arrived = resolve;
                });
                const server = createServer((request, response) => {
                    void (async () => {
                        if (
                            request.method === 'PUT' &&
                            request.url
                                ?.split('?')[0]
                                ?.endsWith('/extraction.json')
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
                let processing: Promise<void> | undefined;
                let proxyDocumentId: string | undefined;
                try {
                    const proxyStorage = await f.owner.rag.credentials.create({
                        name: 'Delayed JSON storage',
                        data: { ...data, endpoint: proxy },
                    });
                    await f.owner.rag.credentials.activate({
                        id: proxyStorage.id,
                    });
                    const before = (await f.owner.rag.quota({})).usage
                        .storageBytes;
                    const doc = await upload('text-fr-en.pdf');
                    proxyDocumentId = doc.id;
                    const original = await version(doc.versionId);
                    const key = `${f.org}/${doc.id}/${doc.versionId}/extraction.json`;
                    processing = processDocumentIngestions(
                        prisma,
                        parseRichDocument
                    );
                    await Promise.race([
                        held,
                        processing.then(() =>
                            assert.fail(
                                'The real JSON PUT did not reach the forwarding proxy.'
                            )
                        ),
                    ]);
                    await f.owner.rag.documents.delete({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                        retentionDays: 0,
                    });
                    await processDocumentCleanups(prisma);
                    assert.equal(
                        (await version(doc.versionId)).discardedAt,
                        null,
                        'Live lease/grace protects the in-flight external write.'
                    );
                    // Deliberately exceed the external I/O bound using only this fixture's timestamps.
                    await clean(doc.id);
                    assert.equal(
                        (await version(doc.versionId)).cleanup?.status,
                        'COMPLETE'
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                    assert.equal(await objectExists(key), false);
                    release();
                    await processing;
                    const reopened = await version(doc.versionId);
                    assert.equal(await objectExists(key), true);
                    assert.equal(reopened.cleanup?.status, 'PENDING');
                    assert.equal(reopened.cleanup?.completedAt, null);
                    assert.ok(reopened.discardedAt);
                    assert.equal(reopened.contentState, 'PURGED');
                    assert.equal(
                        reopened.ingestion?.reservedBytes,
                        original.byteSize + BigInt(RICH_RESERVATION_BYTES)
                    );
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before +
                            Number(original.byteSize) +
                            RICH_RESERVATION_BYTES
                    );
                    assert.equal(reopened.extraction, null);
                    await assert.rejects(
                        f.owner.rag.documents.sourcePreview({ id: doc.id }),
                        { code: 'NOT_FOUND' }
                    );
                    await clean(doc.id);
                    assert.equal(await objectExists(key), false);
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                } finally {
                    release();
                    if (processing) await Promise.allSettled([processing]);
                    if (proxyDocumentId) {
                        const document =
                            await prisma.document.findUniqueOrThrow({
                                where: { id: proxyDocumentId },
                            });
                        const latest =
                            await prisma.documentVersion.findFirstOrThrow({
                                where: {
                                    organizationId: f.org,
                                    documentId: proxyDocumentId,
                                },
                                orderBy: { version: 'desc' },
                            });
                        if (!document.deletedAt)
                            await f.owner.rag.documents.delete({
                                id: proxyDocumentId,
                                expectedVersionId: latest.id,
                                retentionDays: 0,
                            });
                        await clean(proxyDocumentId);
                    }
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
        await t.test(
            'deletion during real parsing fences the later JSON write without reopening completed cleanup',
            async () => {
                let release!: () => void;
                let arrived!: () => void;
                const gate = new Promise<void>((resolve) => {
                    release = resolve;
                });
                const held = new Promise<void>((resolve) => {
                    arrived = resolve;
                });
                const before = (await f.owner.rag.quota({})).usage.storageBytes;
                const doc = await upload('text-fr-en.pdf');
                const key = `${f.org}/${doc.id}/${doc.versionId}/extraction.json`;
                const processing = processDocumentIngestions(
                    prisma,
                    async (bytes, mediaType) => {
                        const parsed = await parseRichDocument(
                            bytes,
                            mediaType
                        );
                        arrived();
                        await gate;
                        return parsed;
                    }
                );
                try {
                    await Promise.race([
                        held,
                        processing.then(() =>
                            assert.fail(
                                'The real parser did not reach the held completion.'
                            )
                        ),
                    ]);
                    await f.owner.rag.documents.delete({
                        id: doc.id,
                        expectedVersionId: doc.versionId,
                        retentionDays: 0,
                    });
                    await clean(doc.id);
                    release();
                    await processing;
                    const final = await version(doc.versionId);
                    assert.equal(final.cleanup?.status, 'COMPLETE');
                    assert.equal(final.ingestion?.reservedBytes, 0n);
                    assert.ok(final.discardedAt);
                    assert.equal(final.extraction, null);
                    assert.equal(await objectExists(key), false);
                    assert.equal(
                        (await f.owner.rag.quota({})).usage.storageBytes,
                        before
                    );
                } finally {
                    release();
                    await Promise.allSettled([processing]);
                }
            }
        );
    } finally {
        // Do not leave fixture objects behind; retained metadata is later removed by the shared organization teardown.
        for (const id of created) {
            const latest = await prisma.documentVersion.findFirst({
                where: { organizationId: f.org, documentId: id },
                orderBy: { version: 'desc' },
            });
            const document = await prisma.document.findUnique({
                where: { id },
            });
            if (!latest || !document) continue;
            if (!document.deletedAt)
                await f.owner.rag.documents.delete({
                    id,
                    expectedVersionId: latest.id,
                    retentionDays: 0,
                });
            await clean(id);
        }
        s3.destroy();
    }
}
