import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { IndexTask, Prisma, PrismaClient } from '@repo/db';
import { EmbeddingError } from '@repo/embeddings';
import { VectorStoreError } from '@repo/vector-store';
import { StorageError } from '@repo/storage';
import { ChunkingError } from '@repo/chunking';
import { DocumentParserError } from '@repo/documents';
import { permits } from '@repo/auth/permissions';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { indexFailure } from '@repo/api-contracts/v1/rag/indexing-types';
import { grantWhere } from '../access';
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
            attempts: { increment: 1 },
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

/** Recheck the initiating member and document-management grant before provider cost and publication. */
export async function requireIndexAuthority(
    db: Prisma.TransactionClient,
    task: Pick<IndexTask, 'organizationId' | 'collectionId' | 'requestedBy'>
) {
    const member = await getMemberPermissions(
        task.organizationId,
        task.requestedBy,
        db
    );
    if (
        !member ||
        !permits(member.permissions, { ragCollection: ['manageDocuments'] })
    )
        throw new IndexingError('ACCESS_REVOKED');
    const collection = await db.collection.findFirst({
        where: {
            AND: [
                { id: task.collectionId, organization: { isActive: true } },
                grantWhere(
                    {
                        organizationId: task.organizationId,
                        userId: task.requestedBy,
                        memberId: member.member.id,
                        keyId: null,
                        permissions: member.permissions,
                    },
                    'manageDocuments'
                ),
            ],
        },
    });
    if (!collection) throw new IndexingError('ACCESS_REVOKED');
    return collection;
}

/** Whitelist diagnostic codes; raw provider, storage, Prisma and driver messages are never persisted. */
export function indexErrorCode(error: unknown): IndexFailure {
    if (error instanceof IndexingError) return error.code;
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
    if (error instanceof ORPCError) {
        if (
            error.data &&
            typeof error.data === 'object' &&
            'errorCode' in error.data
        ) {
            const diagnostic = indexFailure.safeParse(error.data.errorCode);
            if (diagnostic.success) return diagnostic.data;
        }
        return error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND'
            ? 'ACCESS_REVOKED'
            : 'CREDENTIALS_INVALID';
    }
    return 'PROCESSING_FAILED';
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
