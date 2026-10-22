import type { IndexTask, PrismaClient } from '@repo/db';
import { decodeStoredExtraction } from '@repo/documents';
import { planParentContext, type PlannedChunk } from '@repo/chunking';
import {
    modelIdentity,
    embeddingInputByteLimit,
    embedDocuments,
} from '@repo/embeddings';
import { readObject } from '@repo/storage';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { runSerializableTransaction } from '@routers/utils/transactions';
import type { TelemetryExecution } from '../telemetry/types';
import { measureSyncTelemetry, measureTelemetry } from '../telemetry/domain';
import { boundStorage, contentHash } from '../documents/storage';
import {
    boundEmbeddingConfiguration,
    matchesEmbeddingIdentity,
} from './embedding-profile';
import { generationVectorAdapter } from './generation-adapter';
import {
    requireGenerationChunking,
    requireSemanticPlanVersion,
} from './generation-profile';
import { planSemanticCandidate } from './semantic-planning';
import {
    createSemanticWorkObserver,
    releaseSemanticWorkAllowance,
    lockSemanticAccounting,
} from './semantic-work';
import { collectIndexChunks } from './planned-chunks';
import { materializeIndexChunks } from './chunk-materialization';
import { reserveCandidateChunks } from './accounting';
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
    task: IndexTask,
    telemetry?: TelemetryExecution
) {
    if (!task.indexedDocumentId) throw new IndexingError('PROCESSING_FAILED');
    const candidateId = task.indexedDocumentId;
    await renewIndexClaim(db, claim, 'READING_SOURCE');
    await requireIndexAuthority(db, task);
    const { candidate } = await requireCurrentCandidate(db, claim, candidateId);
    const chunker = await requireGenerationChunking(
        db,
        claim.organizationId,
        claim.generationId
    );
    if (chunker.kind === 'SEMANTIC')
        await requireSemanticPlanVersion(
            db,
            claim.organizationId,
            claim.generationId,
            candidateId
        );
    const binding = await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId
    );
    const identity = modelIdentity.parse(binding.generation.capabilitySnapshot);
    const profile = binding.configuration;
    if (
        !matchesEmbeddingIdentity(
            identity,
            profile,
            binding.generation.modelIdentity
        )
    )
        throw new IndexingError('MODEL_CHANGED');
    const credentials = await boundEmbeddingConfiguration(
        db,
        claim.organizationId,
        claim.collectionId,
        binding.generation.configurationRevision
    );
    const artifact = await measureTelemetry(
        telemetry,
        'SOURCE_READ',
        async () =>
            readObject(
                await boundStorage(
                    db,
                    claim.organizationId,
                    candidate.extraction.storageLocationId
                ),
                candidate.extraction.objectKey,
                MAX_DOCUMENT_BYTES
            )
    );
    telemetry?.sourceRead(artifact.byteLength);
    const extraction = decodeStoredExtraction(
        artifact,
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
    const options = {
        ...chunking,
        maxEmbeddingInputBytes: Math.min(
            49_152,
            embeddingInputByteLimit(identity, {
                title: candidate.fileName,
                preparation: profile.preparation,
            })
        ),
    };
    const plans: PlannedChunk[] =
        chunker.kind === 'SEMANTIC'
            ? await planSemanticCandidate(db, {
                  claim,
                  task,
                  candidateId,
                  credentials,
                  identity,
                  preparation: profile.preparation,
                  title: candidate.fileName,
                  telemetry,
                  context: {
                      artifact: extraction,
                      options,
                      sourceHash: contentHash(
                          JSON.stringify({
                              extractorVersion: candidate.extractorVersion,
                              extraction,
                          })
                      ),
                      profileHash: contentHash(
                          JSON.stringify({
                              revision:
                                  binding.generation.configurationRevision,
                              provider: profile.provider,
                              model: profile.model,
                              dimensions: profile.dimensions,
                              preset: profile.embeddingPreset,
                              preparation: profile.preparation,
                              credentialId: profile.credentialId,
                              credentialRevision: profile.credentialRevision,
                              endpoint: profile.endpoint,
                              fileName: candidate.fileName,
                              sourceVersionId: candidate.sourceVersionId,
                              extractionId: candidate.extractionId,
                              capabilitySnapshot:
                                  binding.generation.capabilitySnapshot,
                              options,
                          })
                      ),
                      modelIdentity: binding.generation.modelIdentity,
                      dimensions: identity.dimensions,
                      configurationRevision:
                          binding.generation.configurationRevision,
                  },
              })
            : measureSyncTelemetry(telemetry, 'PLAN', () =>
                  collectIndexChunks(chunker.plan(extraction, options))
              );
    const layout = measureSyncTelemetry(telemetry, 'PLAN', () =>
        chunker.parentContextVersion
            ? planParentContext(extraction, plans, {
                  parentMaxTokens: chunking.parentMaxTokens,
              })
            : undefined
    );
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
    const { chunks, hash } = await measureTelemetry(
        telemetry,
        'MATERIALIZE_SEAL',
        () =>
            materializeIndexChunks(db, {
                claim,
                task,
                candidateId,
                language: candidate.language,
                fileName: candidate.fileName,
                preparation: profile.preparation,
                identity,
                children: plans,
                layout,
            })
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
    const opened = await measureTelemetry(telemetry, 'VECTOR_WRITE_SEAL', () =>
        binding.store.open(binding.spec, publication, claim.leaseEpoch)
    );
    if (opened.state === 'OPEN') {
        for (let start = 0; start < chunks.length; start += 64) {
            await renewIndexClaim(db, claim, 'EMBEDDING');
            await requireIndexAuthority(db, task);
            await requireCurrentCandidate(db, claim, candidateId);
            const rows = await db.chunk.findMany({
                where: {
                    indexedDocumentId: candidateId,
                    kind: 'CHILD',
                    ordinal: { gte: start, lt: start + 64 },
                },
                orderBy: { ordinal: 'asc' },
            });
            const embedded = await measureTelemetry(
                telemetry,
                'FINAL_EMBED',
                () =>
                    embedDocuments(
                        credentials,
                        identity,
                        rows.map((row) => ({
                            text: row.text,
                            title: candidate.fileName,
                        })),
                        {
                            preparation: profile.preparation,
                            timeoutMs: 90_000,
                            numericObserver: telemetry?.nativeObserver,
                            ...(chunker.kind === 'SEMANTIC'
                                ? {
                                      batchObserver: createSemanticWorkObserver(
                                          db,
                                          claim,
                                          task,
                                          candidateId,
                                          'FINAL_DOCUMENT',
                                          `final:${start}`
                                      ),
                                  }
                                : {}),
                        }
                    )
            );
            await renewIndexClaim(db, claim, 'WRITING_VECTORS');
            await requireCurrentCandidate(db, claim, candidateId);
            await measureTelemetry(telemetry, 'VECTOR_WRITE_SEAL', () =>
                binding.store.write(
                    binding.spec,
                    publication,
                    claim.leaseEpoch,
                    rows.map((row, index) => ({
                        chunkId: row.id,
                        ordinal: row.ordinal,
                        chunkHash: row.textHash,
                        vector: embedded.vectors[index]!,
                    }))
                )
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
    await measureTelemetry(telemetry, 'VECTOR_WRITE_SEAL', () =>
        binding.store.seal(binding.spec, publication, claim.leaseEpoch)
    );
    await measureTelemetry(telemetry, 'CATALOG_PUBLISH', () =>
        runSerializableTransaction(db, async (tx) => {
            if (chunker.kind === 'SEMANTIC')
                await lockSemanticAccounting(tx, claim.organizationId);
            await requireIndexAuthority(tx, task);
            await publishIndexedCandidate(tx, claim, task, candidateId, hash);
            if (chunker.kind === 'SEMANTIC')
                await releaseSemanticWorkAllowance(tx, candidateId);
        })
    );
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
