import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { IndexTask, Prisma, PrismaClient } from '@repo/db';
import { EmbeddingError } from '@repo/embeddings';
import { VectorStoreError } from '@repo/vector-store';
import { StorageError } from '@repo/storage';
import { ChunkingError, SemanticStateError } from '@repo/chunking';
import {
    releaseSemanticWorkAllowance,
    lockSemanticAccounting,
} from './semantic-work';
import { DocumentParserError } from '@repo/documents';
import { indexFailure } from '@repo/api-contracts/v1/rag/indexing-types';
import {
    requireIndexDocumentAuthority,
    requireIndexRebuildAuthority,
} from './access';
import { isPendingRebuild } from './sync-authority';
import { runSerializableTransaction } from '@routers/utils/transactions';

export const INDEX_LEASE_MS = 120_000;
export type IndexFailure = typeof indexFailure._output;
export type IndexClaim = Pick<
    IndexTask,
    'id' | 'organizationId' | 'collectionId' | 'generationId' | 'leaseEpoch'
> & { token: string };
export class IndexingError extends Error {
    constructor(readonly code: IndexFailure) {
        super(code);
    }
}
/** Internal control flow: expired workers stop without overwriting a newer claim. */
export class IndexLeaseLost extends Error {}

/** Claim a bounded durable task using a compare-and-set lease and a monotone vector fencing epoch. */
export async function claimIndexTask(
    db: PrismaClient,
    task: IndexTask
): Promise<IndexClaim | null> {
    const token = randomUUID();
    const claimed = await db.indexTask.updateMany({
        where: {
            id: task.id,
            leaseEpoch: task.leaseEpoch,
            continuationPending: task.continuationPending,
            availableAt: { lte: new Date() },
            OR: [
                { status: 'PENDING' },
                { status: 'PROCESSING', leasedUntil: { lte: new Date() } },
            ],
        },
        data: {
            status: 'PROCESSING',
            leaseToken: token,
            leasedUntil: new Date(Date.now() + INDEX_LEASE_MS),
            leaseEpoch: { increment: 1 },
            attempts: { increment: task.continuationPending ? 0 : 1 },
            continuationPending: false,
            errorCode: null,
        },
    });
    return claimed.count
        ? {
              id: task.id,
              organizationId: task.organizationId,
              collectionId: task.collectionId,
              generationId: task.generationId,
              leaseEpoch: task.leaseEpoch + 1n,
              token,
          }
        : null;
}

/** Renew before each bounded external operation and inside every state-changing transaction. */
export async function renewIndexClaim(
    db: Prisma.TransactionClient,
    claim: IndexClaim,
    stage?: string
) {
    const updated = await db.indexTask.updateMany({
        where: {
            id: claim.id,
            organizationId: claim.organizationId,
            generationId: claim.generationId,
            status: 'PROCESSING',
            leaseToken: claim.token,
            leaseEpoch: claim.leaseEpoch,
            leasedUntil: { gt: new Date() },
        },
        data: {
            leasedUntil: new Date(Date.now() + INDEX_LEASE_MS),
            ...(stage ? { stage } : {}),
        },
    });
    if (!updated.count) throw new IndexLeaseLost();
}

/** Recheck the accepted task executor and current grants; a task-scoped retry need not adopt future synchronization. */
export async function requireIndexAuthority(
    db: Prisma.TransactionClient,
    task: Pick<
        IndexTask,
        'organizationId' | 'collectionId' | 'generationId' | 'requestedBy'
    >
) {
    try {
        const collection = await requireIndexDocumentAuthority(db, task);
        const generation = await db.indexGeneration.findFirst({
            where: {
                id: task.generationId,
                organizationId: task.organizationId,
                collectionId: task.collectionId,
            },
            select: {
                previousGenerationId: true,
                authorityUserId: true,
                createdBy: true,
                status: true,
            },
        });
        if (!generation) throw new IndexingError('ACCESS_REVOKED');
        if (isPendingRebuild(generation))
            await requireIndexRebuildAuthority(db, {
                ...task,
                requestedBy: generation.authorityUserId ?? generation.createdBy,
            });
        return collection;
    } catch (error) {
        // Late semantic usage must commit before a known authority denial is
        // surfaced; keep this boundary's existing domain error classification.
        if (
            error instanceof ORPCError &&
            (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
        )
            throw new IndexingError('ACCESS_REVOKED');
        throw error;
    }
}

/** Whitelist diagnostic codes; raw provider, storage, Prisma and driver messages are never persisted. */
export function indexErrorCode(error: unknown): IndexFailure {
    if (error instanceof IndexingError) return error.code;
    if (error instanceof SemanticStateError) return 'PROCESSING_FAILED';
    if (error instanceof EmbeddingError)
        return error.code === 'INVALID_CONFIGURATION'
            ? 'CREDENTIALS_INVALID'
            : error.code;
    if (error instanceof StorageError) return 'STORAGE_UNAVAILABLE';
    if (error instanceof ChunkingError)
        return error.code === 'CHUNK_LIMIT'
            ? 'CHUNK_LIMIT'
            : 'PROFILE_UNSUPPORTED';
    if (error instanceof DocumentParserError) return 'SOURCE_UNAVAILABLE';
    if (error instanceof VectorStoreError)
        return [
            'DESTINATION_DRIFT',
            'SHAPE_MISMATCH',
            'INVALID_INPUT',
        ].includes(error.code)
            ? 'VECTOR_BINDING_CHANGED'
            : 'VECTOR_UNAVAILABLE';
    if (error instanceof ORPCError)
        return rpcIndexErrorCode(error.data, error.code);
    return 'PROCESSING_FAILED';
}

/** Preserve typed domain diagnostics while keeping untrusted RPC details out of durable worker state. */
function rpcIndexErrorCode(data: unknown, code: unknown): IndexFailure {
    if (data && typeof data === 'object' && 'errorCode' in data) {
        const diagnostic = indexFailure.safeParse(data.errorCode);
        if (diagnostic.success) return diagnostic.data;
    }
    return code === 'FORBIDDEN' || code === 'NOT_FOUND'
        ? 'ACCESS_REVOKED'
        : 'CREDENTIALS_INVALID';
}

/** Retry transient work with bounded backoff; terminal failures remain inspectable and explicitly retryable. */
export async function failIndexClaim(
    db: PrismaClient,
    claim: IndexClaim,
    error: unknown
) {
    if (error instanceof IndexLeaseLost) return;
    const code = indexErrorCode(error);
    const task = await db.indexTask.findFirst({
        where: {
            id: claim.id,
            leaseToken: claim.token,
            leaseEpoch: claim.leaseEpoch,
        },
    });
    if (!task) return;
    const terminal =
        task.attempts >= 5 ||
        [
            'ACCESS_REVOKED',
            'PROFILE_UNSUPPORTED',
            'CREDENTIALS_INVALID',
            'MODEL_NOT_FOUND',
            'MODEL_UNSUPPORTED',
            'MODEL_CHANGED',
            'DIMENSIONS_UNSUPPORTED',
            'INPUT_TOO_LARGE',
            'VECTOR_BINDING_CHANGED',
            'SOURCE_UNAVAILABLE',
            'CHUNK_LIMIT',
            'QUOTA_EXCEEDED',
        ].includes(code);
    await runSerializableTransaction(db, async (tx) => {
        if (
            task.indexedDocumentId &&
            (await tx.semanticChunkPlan.findUnique({
                where: { indexedDocumentId: task.indexedDocumentId },
                select: { indexedDocumentId: true },
            }))
        )
            await lockSemanticAccounting(tx, claim.organizationId);
        const failed = await tx.indexTask.updateMany({
            where: {
                id: claim.id,
                status: 'PROCESSING',
                leaseToken: claim.token,
                leaseEpoch: claim.leaseEpoch,
                leasedUntil: { gt: new Date() },
            },
            data: {
                status: terminal ? 'FAILED' : 'PENDING',
                continuationPending: false,
                stage: 'FAILED',
                errorCode: code,
                leaseToken: null,
                leasedUntil: null,
                availableAt: new Date(
                    Date.now() + Math.min(300_000, 5000 * 2 ** task.attempts)
                ),
            },
        });
        if (!failed.count) return;
        if (terminal && task.indexedDocumentId)
            await releaseSemanticWorkAllowance(tx, task.indexedDocumentId);
        if (task.indexedDocumentId) {
            const candidate = await tx.indexedDocument.findUnique({
                where: { id: task.indexedDocumentId },
            });
            if (candidate)
                await tx.generationDocument.updateMany({
                    where: {
                        organizationId: claim.organizationId,
                        generationId: task.generationId,
                        documentId: candidate.documentId,
                        buildRevision: candidate.buildRevision,
                    },
                    data: { lastErrorCode: code },
                });
        }
        if (task.kind === 'PROVISION')
            await tx.indexGeneration.updateMany({
                where: { id: claim.generationId, status: 'PROVISIONING' },
                data: { lastErrorCode: code },
            });
    });
}

/** Complete only this live lease; reservations must already have been materialized or released. */
export async function completeIndexClaim(
    db: Prisma.TransactionClient,
    claim: IndexClaim
) {
    await renewIndexClaim(db, claim);
    await db.indexTask.update({
        where: { id: claim.id },
        data: {
            status: 'COMPLETE',
            stage: 'COMPLETE',
            errorCode: null,
            leaseToken: null,
            leasedUntil: null,
            completedAt: new Date(),
        },
    });
}
