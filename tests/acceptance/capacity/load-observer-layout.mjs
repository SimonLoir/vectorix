/** One-document canonical geometry validator; at most500 children plus500 parents remain in memory. */
import { createHash } from 'node:crypto';
import {
    need,
    same,
    sha,
    digest,
    OBSERVER_LIMITS,
} from './load-observer-core.mjs';
export const RUNTIME_DRAFT_ONLY = true;
export function sourceFormat(descriptor) {
    const pairs = {
        'text/plain': ['utf8-text-v1', 'TEXT'],
        'text/markdown': ['utf8-text-v1', 'MARKDOWN'],
        'application/pdf': ['pdf-structured-v1', 'PDF'],
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            ['docx-structured-v1', 'DOCX'],
    };
    const value = pairs[descriptor.mediaType];
    need(value, 'LOAD_OBS_SOURCE');
    return { extractorVersion: value[0], format: value[1] };
}
export function validateDocumentLayout({
    candidate,
    descriptor,
    artifact,
    children,
    parents,
    mapping,
    rows,
    physical,
    ledger,
    prepare,
    manifestHash,
    identity,
}) {
    need(
        children.length <= 500 &&
            children.length > 0 &&
            parents.length <= 500 &&
            rows.length === children.length + parents.length &&
            rows.length <= OBSERVER_LIMITS.rowsPerDocument,
        'LOAD_OBS_LAYOUT_BOUND'
    );
    const expectedSource = sourceFormat(descriptor);
    need(
        sha(artifact.text) === descriptor.canonicalSha256 &&
            candidate.sha256 === descriptor.originalSha256 &&
            candidate.version === 1 &&
            candidate.mediaType === descriptor.mediaType &&
            candidate.extractorVersion === expectedSource.extractorVersion &&
            artifact.format === expectedSource.format &&
            candidate.fileName === descriptor.fileName,
        'LOAD_OBS_SOURCE'
    );
    need(
        candidate.status === 'PUBLISHED' &&
            candidate.sourceState === 'AVAILABLE' &&
            candidate.sourceStatus === 'READY' &&
            candidate.extractionDiscardedAt === null &&
            candidate.discardedAt === null &&
            candidate.publishedAt &&
            candidate.vectorSealedAt &&
            candidate.chunkCount === children.length &&
            candidate.materializedChunks === children.length &&
            candidate.holdState === 'LIVE',
        'LOAD_OBS_PUBLICATION'
    );
    need(
        physical.length === children.length &&
            ledger?.state === 'SEALED' &&
            ledger.document_id === candidate.documentId &&
            ledger.source_version_id === candidate.sourceVersionId &&
            ledger.expected_count === children.length &&
            ledger.manifest_hash === candidate.manifestHash,
        'LOAD_OBS_VECTOR_LEDGER'
    );
    const geometry = createHash('sha256'),
        preparedHashes = createHash('sha256'),
        parentGeometry = createHash('sha256');
    let preparedBytes = 0,
        estimatedInputTokens = 0;
    const expectedRows = [...children, ...parents];
    rows.forEach((row, index) => {
        const planned = expectedRows[index],
            child = index < children.length;
        need(
            row.ordinal === index &&
                row.kind === (child ? 'CHILD' : 'PARENT') &&
                row.startOffset === planned.start &&
                row.endOffset === planned.end &&
                row.text === planned.text &&
                row.text ===
                    artifact.text.slice(row.startOffset, row.endOffset) &&
                row.textHash === sha(planned.text) &&
                same(row.sourceSpans, planned.sourceSpans) &&
                row.sourceSpanCount === planned.sourceSpans.length &&
                row.tokenCount === planned.tokenCount &&
                row.tokenCountIsEstimate === true,
            'LOAD_OBS_CANONICAL_ROW'
        );
        need(
            row.indexedDocumentId === candidate.id &&
                row.generationId === candidate.generationId &&
                row.organizationId === candidate.organizationId,
            'LOAD_OBS_SOURCE'
        );
        if (child) {
            const prepared = prepare(identity, 'document', planned.text, {
                    title: candidate.fileName,
                    preparation: '',
                }),
                inputHash = sha(prepared);
            need(
                row.embeddingInputHash === inputHash &&
                    Buffer.byteLength(prepared) <=
                        identity.contextTokens - 32 &&
                    row.parentId === rows[mapping[index]]?.id,
                'LOAD_OBS_PREPARED_INPUT'
            );
            preparedBytes += Buffer.byteLength(prepared);
            estimatedInputTokens += Math.ceil(Buffer.byteLength(prepared) / 4);
            geometry.update(
                JSON.stringify([
                    index,
                    planned.start,
                    planned.end,
                    row.textHash,
                    inputHash,
                    planned.sourceSpans.map((span) => [
                        span.source.index,
                        span.start,
                        span.end,
                    ]),
                ]) + '\n'
            );
            preparedHashes.update(JSON.stringify([index, inputHash]) + '\n');
            const vector = physical[index];
            need(
                vector?.chunk_id === row.id &&
                    vector.ordinal === index &&
                    vector.chunk_hash === row.textHash &&
                    vector.publication_id === candidate.id &&
                    vector.document_id === candidate.documentId &&
                    vector.source_version_id === candidate.sourceVersionId &&
                    vector.generation_id === candidate.generationId &&
                    vector.dimensions === 768 &&
                    vector.finite_nonzero === true,
                'LOAD_OBS_PHYSICAL_ROW'
            );
        } else {
            need(
                row.parentId === null &&
                    row.embeddingInputHash === null &&
                    Buffer.byteLength(row.text) <= 6144,
                'LOAD_OBS_PARENT'
            );
            parentGeometry.update(
                JSON.stringify([
                    row.ordinal,
                    planned.start,
                    planned.end,
                    row.textHash,
                ]) + '\n'
            );
        }
    });
    const manifest = manifestHash(
        rows.slice(0, children.length).map((row) => ({
            chunkId: row.id,
            ordinal: row.ordinal,
            chunkHash: row.textHash,
        }))
    );
    need(
        manifest === candidate.manifestHash &&
            manifestHash(
                physical.map((row) => ({
                    chunkId: row.chunk_id,
                    ordinal: row.ordinal,
                    chunkHash: row.chunk_hash,
                }))
            ) === manifest,
        'LOAD_OBS_MANIFEST'
    );
    const result = {
        documentId: candidate.documentId,
        versionId: candidate.sourceVersionId,
        version: 1,
        originalSha256: candidate.sha256,
        canonicalSha256: sha(artifact.text),
        childCount: children.length,
        parentCount: parents.length,
        geometrySha256: geometry.digest('hex'),
        preparedInputHashesSha256: preparedHashes.digest('hex'),
        parentGeometrySha256: parentGeometry.digest('hex'),
        childParentMappingSha256: sha(JSON.stringify(mapping)),
        manifestSha256: manifest,
        preparedBytes,
        estimatedInputTokens,
    };
    if (descriptor.expectedGeometrySha256)
        need(
            result.geometrySha256 === descriptor.expectedGeometrySha256 &&
                result.childCount === 500 &&
                result.parentCount === 125,
            'LOAD_OBS_FROZEN_GEOMETRY'
        );
    return result;
}
export const generationManifest = (publications) =>
    digest(
        publications
            .map((row) => [
                row.documentId,
                row.versionId,
                row.manifestSha256,
                row.geometrySha256,
                row.parentGeometrySha256,
                row.childParentMappingSha256,
            ])
            .sort((a, b) => a[0].localeCompare(b[0]))
    );
