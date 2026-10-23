import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    GetObjectCommand,
    HeadObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { prisma, type Prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { parseRichDocument } from '../../../workers/src/extraction/main';
import { fixture as f } from './fixtures';
import { cleanParentCollection, createParentFixture } from './parent-fixtures';
import { scanSemantic } from './semantic-fixtures';

export type PdfXrefVersion = Prisma.DocumentVersionGetPayload<{
    include: { ingestion: true; extraction: true; cleanup: true };
}>;
export type PdfXrefPublication = Prisma.IndexedDocumentGetPayload<{
    include: { sourceHold: true };
}>;

export const pdfXrefPages = [
    'English source - page one.\nVectorix preserves PDF page references.',
    'Bonjour équipe - page deux.\nTexte français : été, élève et façade.',
] as const;
export const pdfXrefText = pdfXrefPages.join('\n\n');
export const pdfXrefSources = [
    { kind: 'pdf-page', index: 0, page: 1, start: 0, end: 66 },
    { kind: 'pdf-page', index: 1, page: 2, start: 68, end: 134 },
] as const;

export function pdfXrefHash(bytes: Uint8Array | string) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** Read only the fixed synthetic parser fixtures; client MIME remains deliberately untrusted. */
export async function pdfXrefFile(
    name:
        'xref-reconstructed.pdf' | 'xref-partial-corrupt.pdf' | 'text-fr-en.pdf'
) {
    const bytes = await readFile(
        new URL(`../../../../tests/documents/fixtures/${name}`, import.meta.url)
    );
    return new File([new Uint8Array(bytes)], name, { type: 'text/plain' });
}

/** Actual Poppler, private objects and application/vector stores; only embeddings use the existing synthetic HTTP fixture. */
export async function createPdfXrefFixture() {
    assert.ok(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'));
    const indexing = await createParentFixture('PDF xref recovery', true);
    const created: string[] = [];
    const generations: string[] = [];
    const bucket = process.env.VECTORIX_DEFAULT_S3_BUCKET!;
    const s3 = new S3Client({
        endpoint: process.env.VECTORIX_DEFAULT_S3_ENDPOINT!,
        region: 'us-east-1',
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
            accessKeyId: process.env.VECTORIX_DEFAULT_S3_ACCESS_KEY_ID!,
            secretAccessKey: process.env.VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY!,
        },
    });
    const collection = await indexing
        .collection('PDF xref publication', 'DOCUMENT_STRUCTURE')
        .catch(async (error: unknown) => {
            s3.destroy();
            await indexing.close();
            throw error;
        });

    function version(id: string): Promise<PdfXrefVersion> {
        return prisma.documentVersion.findFirstOrThrow({
            where: { id, organizationId: indexing.organizationId },
            include: { ingestion: true, extraction: true, cleanup: true },
        });
    }
    /** Process saved originals through the production parser, without inventing an extraction success. */
    async function settle(versionId: string) {
        for (let attempt = 0; attempt < 5; attempt++) {
            await processDocumentIngestions(prisma, parseRichDocument);
            const stored = await version(versionId);
            assert.ok(stored.ingestion);
            if (['READY', 'FAILED'].includes(stored.ingestion.status))
                return stored;
        }
        assert.fail('The isolated PDF xref ingestion did not settle.');
    }
    /** Bounds both advertised and actual bytes for tiny synthetic S3 evidence. */
    async function objectBytes(key: string) {
        const response = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key }),
            { abortSignal: AbortSignal.timeout(5000) }
        );
        assert.ok(
            response.Body &&
                response.ContentLength !== undefined &&
                response.ContentLength <= 64 * 1024,
            'The synthetic PDF evidence object must be bounded.'
        );
        const reader = response.Body.transformToWebStream().getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                size += next.value.byteLength;
                assert.ok(
                    size <= 64 * 1024,
                    'The evidence stream exceeded its cap.'
                );
                chunks.push(next.value);
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        return Buffer.concat(chunks, size);
    }
    async function objectExists(key: string) {
        try {
            await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
                abortSignal: AbortSignal.timeout(5000),
            });
            return true;
        } catch (error) {
            if (error instanceof Error && error.name === 'NotFound')
                return false;
            throw error;
        }
    }
    /** Advance only this disposable document's authorized cleanup deadlines; keep every real source hold intact. */
    async function dueCleanup(documentId: string) {
        await prisma.documentIngestion.updateMany({
            where: {
                organizationId: indexing.organizationId,
                version: { documentId },
            },
            data: { leasedUntil: new Date(0) },
        });
        await prisma.documentCleanup.updateMany({
            where: {
                organizationId: indexing.organizationId,
                version: { documentId },
                status: { not: 'COMPLETE' },
            },
            data: {
                scheduledAt: new Date(0),
                availableAt: new Date(0),
                leasedUntil: new Date(0),
            },
        });
    }

    return {
        indexing,
        collection,
        version,
        settle,
        objectBytes,
        objectExists,
        dueCleanup,
        async upload(file: File, requestId = randomUUID()) {
            const uploaded = await f.owner.rag.documents.upload({
                requestId,
                file,
            });
            created.push(uploaded.id);
            return uploaded;
        },
        async start() {
            const started = await f.owner.rag.indexing.start({
                collectionId: collection.id,
                expectedRevision: collection.configurationRevision,
                requestId: randomUUID(),
            });
            generations.push(started.generationId);
            await scanSemantic(indexing, started.generationId, 8);
            assert.equal(
                (
                    await f.owner.rag.indexing.status({
                        collectionId: collection.id,
                    })
                ).active?.id,
                started.generationId
            );
            return started.generationId;
        },
        publication(documentId: string): Promise<PdfXrefPublication> {
            return prisma.indexedDocument.findFirstOrThrow({
                where: {
                    organizationId: indexing.organizationId,
                    collectionId: collection.id,
                    documentId,
                    status: 'PUBLISHED',
                },
                include: { sourceHold: true },
            });
        },
        async scan(generationId: string) {
            await scanSemantic(indexing, generationId, 6);
        },
        async close() {
            try {
                await cleanParentCollection(
                    indexing,
                    collection.id,
                    generations
                );
                for (const id of created) {
                    const latest =
                        await prisma.documentVersion.findFirstOrThrow({
                            where: {
                                documentId: id,
                                organizationId: indexing.organizationId,
                            },
                            orderBy: { version: 'desc' },
                        });
                    await f.owner.rag.documents.delete({
                        id,
                        expectedVersionId: latest.id,
                        retentionDays: 0,
                    });
                    for (let pass = 0; pass < 12; pass++) {
                        await dueCleanup(id);
                        await processDocumentCleanups(prisma);
                        if (
                            !(await prisma.documentCleanup.count({
                                where: {
                                    organizationId: indexing.organizationId,
                                    version: { documentId: id },
                                    status: { not: 'COMPLETE' },
                                },
                            }))
                        )
                            break;
                    }
                    assert.equal(
                        await prisma.documentCleanup.count({
                            where: {
                                organizationId: indexing.organizationId,
                                version: { documentId: id },
                                status: { not: 'COMPLETE' },
                            },
                        }),
                        0,
                        'Every owned PDF source and artifact must finish real cleanup.'
                    );
                }
            } finally {
                s3.destroy();
                await indexing.close();
            }
        },
    };
}
