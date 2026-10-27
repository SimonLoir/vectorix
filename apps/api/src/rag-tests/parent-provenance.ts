import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { parseRichDocument } from '../../../workers/src/extraction/main';
import { fixture as f } from './fixtures';
import { createParentFixture, scanParent } from './parent-fixtures';

/** A tiny deterministic stored-ZIP fixture supplies real OOXML without adding a runtime ZIP dependency. */
export function paragraphDocument(
    paragraphs: readonly string[] = Array.from(
        { length: 70 },
        (_, index) => `Forêt forest source ${index}.`
    )
) {
    const entries = [
        [
            '[Content_Types].xml',
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ],
        [
            '_rels/.rels',
            '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ],
        [
            'word/document.xml',
            `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`,
        ],
    ] as const;
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, value] of entries) {
        const filename = Buffer.from(name);
        const data = Buffer.from(value, 'utf8');
        const checksum = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04_03_4b_50);
        header.writeUInt16LE(20, 4);
        header.writeUInt32LE(checksum, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(filename.length, 26);
        local.push(header, filename, data);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02_01_4b_50);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt32LE(checksum, 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(data.length, 24);
        record.writeUInt16LE(filename.length, 28);
        record.writeUInt32LE(offset, 42);
        central.push(record, filename);
        offset += header.length + filename.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06_05_4b_50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

/** Real worker parsing produces over64 citations; API projections retain explicit bounded provenance. */
export async function parentProvenanceTests(t: TestContext) {
    await t.test(
        'DOCX child/context preview and search project64 spans while retaining all canonical stored sources',
        async () => {
            const fixture = await createParentFixture(
                'Bounded rich provenance'
            );
            try {
                const collection = await fixture.collection(
                    'Rich parent sources',
                    'TOKEN_WINDOW',
                    2048
                );
                const bytes = paragraphDocument();
                const source = await f.owner.rag.documents.upload({
                    requestId: randomUUID(),
                    file: new File(
                        [new Uint8Array(bytes)],
                        'parent-70-paragraphs.docx'
                    ),
                });
                await processDocumentIngestions(prisma, parseRichDocument);
                assert.equal(
                    (
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: source.versionId },
                        })
                    ).status,
                    'READY'
                );
                await f.owner.rag.documents.setCollection({
                    id: source.id,
                    collectionId: collection.id,
                    attached: true,
                });
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await scanParent(fixture, started.generationId, 6);
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: collection.id,
                        })
                    ).active?.id,
                    started.generationId
                );
                const stored = await prisma.chunk.findFirstOrThrow({
                    where: {
                        generationId: started.generationId,
                        kind: 'PARENT',
                    },
                });
                assert(Array.isArray(stored.sourceSpans));
                assert.equal(stored.sourceSpans.length, 70);
                const preview = await f.owner.rag.indexing.chunks({
                    collectionId: collection.id,
                    documentId: source.id,
                    limit: 100,
                });
                assert(preview.items.length > 1);
                assert(
                    preview.items.every(
                        (row) =>
                            row.parentContext?.id === stored.id &&
                            row.parentContext.sourceSpans.length === 64 &&
                            row.parentContext.sourceSpansTruncated
                    )
                );
                const search = await f.owner.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'forest',
                    strategy: 'HYBRID',
                    topK: 10,
                    filters: {},
                });
                assert.equal(search.results.length, 1);
                assert.equal(search.parentUnderfilled, true);
                const result = search.results[0]!;
                assert.equal(result.parentContext?.sourceSpans.length, 64);
                assert.equal(result.parentContext?.sourceSpansTruncated, true);
                assert.equal(result.parentContext?.text, stored.text);
                const original = await f.owner.rag.indexing.sourceOriginal({
                    collectionId: collection.id,
                    receipt: result.source.receipt,
                });
                assert.equal(
                    createHash('sha256')
                        .update(Buffer.from(await original.arrayBuffer()))
                        .digest('hex'),
                    createHash('sha256').update(bytes).digest('hex')
                );
            } finally {
                await fixture.close();
            }
        }
    );
}
