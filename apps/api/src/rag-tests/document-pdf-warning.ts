import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { fixture as f } from './fixtures';
import {
    type createPdfXrefFixture,
    pdfXrefFile,
    pdfXrefHash,
    pdfXrefPages,
    pdfXrefSources,
    pdfXrefText,
} from './document-pdf-xref-fixture';

type PdfFixture = Awaited<ReturnType<typeof createPdfXrefFixture>>;

/** Reuse the real parser/storage fixture; warning-only success must not admit partial-content corruption. */
export async function documentPdfWarningTests(
    t: TestContext,
    environment: PdfFixture
) {
    const file = await pdfXrefFile('linearization-warning.pdf');
    const original = new Uint8Array(await file.arrayBuffer());
    const originalSha = pdfXrefHash(original);
    const uploaded = await environment.upload(file);
    const ready = await environment.settle(uploaded.versionId);
    assert.equal(ready.status, 'READY');

    await t.test(
        'a text-preserving linearization warning reaches READY with complete native artifact, pages and original bytes',
        async () => {
            assert.equal(ready.ingestion?.status, 'READY');
            assert.equal(ready.ingestion?.attempts, 1);
            assert.equal(ready.ingestion?.errorCode, null);
            assert.equal(ready.ingestion?.reservedBytes, 0n);
            assert.equal(ready.sha256, originalSha);
            assert.ok(ready.extraction);
            assert.equal(
                ready.extraction.extractorVersion,
                'pdf-structured-v1'
            );
            const artifact = Buffer.from(
                JSON.stringify({
                    schemaVersion: 1,
                    format: 'PDF',
                    text: pdfXrefText,
                    sources: pdfXrefSources.map(
                        ({ kind, index, start, end, page }) => ({
                            kind,
                            index,
                            start,
                            end,
                            page,
                        })
                    ),
                    warnings: [],
                })
            );
            assert.deepEqual(
                await environment.objectBytes(ready.extraction.objectKey),
                artifact
            );
            assert.equal(ready.extraction.byteSize, BigInt(artifact.length));
            assert.deepEqual(
                await environment.objectBytes(ready.objectKey),
                Buffer.from(original)
            );
            for (const [sourceIndex, text] of pdfXrefPages.entries()) {
                const preview = await f.owner.rag.documents.sourcePreview({
                    id: uploaded.id,
                    sourceIndex,
                });
                assert.equal(preview.version, 1);
                assert.equal(preview.totalSources, 2);
                assert.equal(preview.text, text);
                assert.deepEqual(preview.source, pdfXrefSources[sourceIndex]);
                assert.deepEqual(preview.warnings, []);
            }
            const download = await f.owner.rag.documents.download({
                id: uploaded.id,
            });
            assert.equal(
                pdfXrefHash(new Uint8Array(await download.arrayBuffer())),
                originalSha
            );
        }
    );

    await t.test(
        'linearization warning plus content corruption fails once and preserves the last READY source',
        async () => {
            const mixed = await pdfXrefFile(
                'linearization-partial-corrupt.pdf'
            );
            const replaced = await f.owner.rag.documents.replace({
                id: uploaded.id,
                expectedVersionId: ready.id,
                requestId: randomUUID(),
                file: mixed,
                retentionDays: 7,
            });
            const failed = await environment.settle(replaced.versionId);
            assert.equal(failed.status, 'FAILED');
            assert.equal(failed.ingestion?.status, 'FAILED');
            assert.equal(failed.ingestion?.attempts, 1);
            assert.equal(failed.ingestion?.errorCode, 'FILE_INVALID');
            assert.equal(failed.extraction, null);
            assert.equal(
                await environment.objectExists(
                    `${environment.indexing.organizationId}/${uploaded.id}/${failed.id}/extraction.json`
                ),
                false
            );
            const lifecycle = await f.owner.rag.documents.lifecycle({
                id: uploaded.id,
            });
            assert.equal(lifecycle.publishedVersionId, ready.id);
            assert.equal(lifecycle.latestVersionId, failed.id);
            const task = lifecycle.versions.find(
                (version) => version.id === failed.id
            )?.task;
            assert.equal(task?.diagnostic, 'FILE_INVALID');
            assert.equal(task?.errorCode, 'TEXT_INVALID');
            assert.ok(
                !JSON.stringify(lifecycle).includes(
                    'Syntax Warning: Length in linearization table is invalid'
                )
            );
            assert.ok(!JSON.stringify(lifecycle).includes('Syntax Error:'));
            const preview = await f.owner.rag.documents.sourcePreview({
                id: uploaded.id,
                sourceIndex: 1,
            });
            assert.equal(preview.version, 1);
            assert.equal(preview.text, pdfXrefPages[1]);
            assert.equal(
                (await f.owner.rag.documents.details({ id: uploaded.id }))
                    .document.status,
                'READY'
            );
            const download = await f.owner.rag.documents.download({
                id: uploaded.id,
            });
            assert.equal(
                pdfXrefHash(new Uint8Array(await download.arrayBuffer())),
                originalSha
            );
        }
    );
}
