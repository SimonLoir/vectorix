import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { IndexTask, PrismaClient } from '@repo/db';
import { decodeStoredExtraction } from '@repo/documents';
import {
    chunkDocumentStructure,
    STRUCTURE_CHUNKER_VERSION,
    type PlannedChunk,
} from '@repo/chunking';
import {
    modelIdentity,
    canonicalOllamaModel,
    embeddingInputByteLimit,
    prepareEmbeddingInput,
    embedDocuments,
} from '@repo/embeddings';
import { readObject } from '@repo/storage';
import { manifestHash } from '@repo/vector-store';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { boundStorage, contentHash } from '../documents/storage';
import {
    boundEmbeddingConfiguration,
    assertM3Profile,
} from './embedding-profile';
import { generationVectorAdapter } from './generation-adapter';
import {
    reserveCandidateChunks,
    accountMaterializedChunks,
} from './accounting';
import {
    requireCurrentCandidate,
    publishIndexedCandidate,
} from './publication-state';
import {
    renewIndexClaim,
    requireIndexAuthority,
    IndexingError,
    type IndexClaim,
} from './task-state';

/** Plan and materialize a bounded canonical candidate before any vector side effect, then seal and publish it. */
export async function executeDocumentIndex(
    db: PrismaClient,
    claim: IndexClaim,
    task: IndexTask
) {
    if (!task.indexedDocumentId) throw new IndexingError('PROCESSING_FAILED');
    const candidateId = task.indexedDocumentId;
    await renewIndexClaim(db, claim, 'READING_SOURCE');
    await requireIndexAuthority(db, task);
    const { candidate } = await requireCurrentCandidate(db, claim, candidateId);
    const binding = await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId
    );
    const identity = modelIdentity.parse(binding.generation.capabilitySnapshot);
    const profile = binding.configuration;
    assertM3Profile(profile);
    if (
        identity.digest !== binding.generation.modelIdentity ||
        identity.model !== canonicalOllamaModel(profile.model) ||
        identity.dimensions !== profile.dimensions ||
        identity.preset !== profile.embeddingPreset ||
        binding.generation.chunkerVersion !== STRUCTURE_CHUNKER_VERSION
    )
        throw new IndexingError('MODEL_CHANGED');
    const credentials = await boundEmbeddingConfiguration(
        db,
        claim.organizationId,
        claim.collectionId,
        binding.generation.configurationRevision
    );
    const extraction = decodeStoredExtraction(
        await readObject(
            await boundStorage(
                db,
                claim.organizationId,
                candidate.extraction.storageLocationId
            ),
            candidate.extraction.objectKey,
            MAX_DOCUMENT_BYTES
        ),
        candidate.extractorVersion
    );
    // Legacy TXT/Markdown artifacts share text.txt and retain exact offsets;
    // the immutable version media type supplies Markdown structure semantics.
    if (
        candidate.extractorVersion === 'utf8-text-v1' &&
        candidate.mediaType === 'text/markdown'
    )
        extraction.format = 'MARKDOWN';
    const chunking = collectionProfile.shape.chunking.parse(profile.chunking);
    const plans: PlannedChunk[] = [];
    let textBytes = 0,
        spanBytes = 0;
    for (const chunk of chunkDocumentStructure(extraction, {
        ...chunking,
        maxEmbeddingInputBytes: Math.min(
            49_152,
            embeddingInputByteLimit(identity, {
                title: candidate.fileName,
                preparation: profile.preparation,
            })
        ),
    })) {
        textBytes += Buffer.byteLength(chunk.text);
        spanBytes += Buffer.byteLength(JSON.stringify(chunk.sourceSpans));
        if (textBytes > 128 * 1024 ** 2 || spanBytes > 32 * 1024 ** 2)
            throw new IndexingError('CHUNK_LIMIT');
        plans.push(chunk);
    }
    if (!plans.length) throw new IndexingError('SOURCE_UNAVAILABLE');
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim, 'PLANNING');
        await requireIndexAuthority(tx, task);
        await requireCurrentCandidate(tx, claim, candidateId);
        await reserveCandidateChunks(tx, {
            ...claim,
            documentId: candidate.documentId,
            candidateId,
            taskId: task.id,
            count: plans.length,
        });
    });
    for (let start = 0; start < plans.length; start += 128) {
        const batch = plans.slice(start, start + 128).map((chunk) => ({
            id: randomUUID(),
            organizationId: claim.organizationId,
            generationId: claim.generationId,
            indexedDocumentId: candidateId,
            ordinal: chunk.ordinal,
            text: chunk.text,
            textHash: contentHash(chunk.text),
            embeddingInputHash: contentHash(
                prepareEmbeddingInput(identity, 'document', chunk.text, {
                    title: candidate.fileName,
                    preparation: profile.preparation,
                })
            ),
            sourceSpans: chunk.sourceSpans.map((span) => ({
                source: { ...span.source },
                start: span.start,
                end: span.end,
            })),
            language: candidate.language,
            tokenCount: chunk.tokenCount,
            tokenCountIsEstimate: true,
        }));
        await runSerializableTransaction(db, async (tx) => {
            await renewIndexClaim(tx, claim, 'MATERIALIZING');
            await requireCurrentCandidate(tx, claim, candidateId);
            const existing = await tx.chunk.findMany({
                where: {
                    indexedDocumentId: candidateId,
                    ordinal: { gte: start, lt: start + batch.length },
                },
                orderBy: { ordinal: 'asc' },
            });
            for (const row of existing) {
                const expected = batch[row.ordinal - start];
                if (
                    !expected ||
                    row.textHash !== expected.textHash ||
                    row.embeddingInputHash !== expected.embeddingInputHash ||
                    !isDeepStrictEqual(row.sourceSpans, expected.sourceSpans)
                )
                    throw new IndexingError('PROCESSING_FAILED');
            }
            const present = new Set(existing.map((row) => row.ordinal));
            const missing = batch.filter((row) => !present.has(row.ordinal));
            if (missing.length) {
                await tx.chunk.createMany({ data: missing });
                await accountMaterializedChunks(tx, {
                    collectionId: claim.collectionId,
                    candidateId,
                    taskId: task.id,
                    count: missing.length,
                });
            }
        });
    }
    const chunks = await db.chunk.findMany({
        where: { indexedDocumentId: candidateId },
        orderBy: { ordinal: 'asc' },
        select: { id: true, ordinal: true, textHash: true },
        take: 100_001,
    });
    if (
        chunks.length !== plans.length ||
        chunks.some((chunk, index) => chunk.ordinal !== index)
    )
        throw new IndexingError('PROCESSING_FAILED');
    const hash = manifestHash(
        chunks.map((chunk) => ({
            chunkId: chunk.id,
            ordinal: chunk.ordinal,
            chunkHash: chunk.textHash,
        }))
    );
    const publication = {
        id: candidateId,
        documentId: candidate.documentId,
        sourceVersionId: candidate.sourceVersionId,
        expectedCount: chunks.length,
        manifestHash: hash,
    };
    await renewIndexClaim(db, claim, 'EMBEDDING');
    await requireCurrentCandidate(db, claim, candidateId);
    const opened = await binding.store.open(
        binding.spec,
        publication,
        claim.leaseEpoch
    );
    if (opened.state === 'OPEN') {
        for (let start = 0; start < chunks.length; start += 64) {
            await renewIndexClaim(db, claim, 'EMBEDDING');
            await requireIndexAuthority(db, task);
            await requireCurrentCandidate(db, claim, candidateId);
            const rows = await db.chunk.findMany({
                where: {
                    indexedDocumentId: candidateId,
                    ordinal: { gte: start, lt: start + 64 },
                },
                orderBy: { ordinal: 'asc' },
            });
            const embedded = await embedDocuments(
                credentials,
                identity,
                rows.map((row) => ({
                    text: row.text,
                    title: candidate.fileName,
                })),
                { preparation: profile.preparation, timeoutMs: 90_000 }
            );
            await renewIndexClaim(db, claim, 'WRITING_VECTORS');
            await requireCurrentCandidate(db, claim, candidateId);
            await binding.store.write(
                binding.spec,
                publication,
                claim.leaseEpoch,
                rows.map((row, index) => ({
                    chunkId: row.id,
                    ordinal: row.ordinal,
                    chunkHash: row.textHash,
                    vector: embedded.vectors[index]!,
                }))
            );
            await db.indexTask.updateMany({
                where: {
                    id: claim.id,
                    leaseToken: claim.token,
                    leaseEpoch: claim.leaseEpoch,
                    status: 'PROCESSING',
                },
                data: { completedChunks: start + rows.length },
            });
        }
    }
    await renewIndexClaim(db, claim, 'SEALING');
    await binding.store.seal(binding.spec, publication, claim.leaseEpoch);
    await runSerializableTransaction(db, async (tx) => {
        await requireIndexAuthority(tx, task);
        await publishIndexedCandidate(tx, claim, task, candidateId, hash);
    });
    // Statistics are advisory: failure after catalog publication does not turn a completed publication into a failed task.
    await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId,
        { provision: true }
    )
        .then((provisioner) => provisioner.store.analyze(provisioner.spec))
        .catch(() => {});
}
