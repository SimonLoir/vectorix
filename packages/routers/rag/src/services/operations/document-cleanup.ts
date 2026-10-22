import type { Prisma } from '@repo/db';
import { ORPCError } from '@orpc/server';
import { permits } from '@repo/auth/permissions';
import { libraryWrite } from '../documents/access';
import type { RagActor } from '../access';
import type { OperationRow, OperationsInput, OperationState } from './types';
import { literalSearch } from './queries';

const states = ['DUE', 'SCHEDULED', 'LEASED', 'EXPIRED', 'FAILED'] as const;

function stateWhere(
    state: OperationsInput['state'],
    at: Date
): Prisma.DocumentCleanupWhereInput {
    switch (state) {
        case 'UPLOADING':
            return { versionId: { in: [] } };
        case 'DUE':
            return { status: 'PENDING', availableAt: { lte: at } };
        case 'SCHEDULED':
            return { status: 'PENDING', availableAt: { gt: at } };
        case 'LEASED':
            return { status: 'PROCESSING', leasedUntil: { gt: at } };
        case 'EXPIRED':
            return {
                status: 'PROCESSING',
                OR: [{ leasedUntil: null }, { leasedUntil: { lte: at } }],
            };
        case 'FAILED':
            return { status: 'FAILED' };
        default:
            return {};
    }
}

/** A late PUT can requeue physical deletion while its source deliberately remains PURGED. */
function cleanupWhere(
    organizationId: string,
    at: Date,
    state: OperationsInput['state']
): Prisma.DocumentCleanupWhereInput {
    return {
        organizationId,
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        AND: stateWhere(state, at),
    };
}

/** Original cleanup has no related-column comparison; keep its scoped aggregates in Prisma. */
export function cleanupCounts(
    db: Prisma.TransactionClient,
    organizationId: string,
    at: Date
) {
    return Promise.all(
        states.map(async (state) => {
            const value = await db.documentCleanup.aggregate({
                where: cleanupWhere(organizationId, at, state),
                _count: { _all: true },
                _min: { createdAt: true },
            });
            return {
                category: 'DOCUMENT_CLEANUP' as const,
                state,
                count: BigInt(value._count._all),
                oldestAcceptedAt: value._min.createdAt,
            };
        })
    );
}

function cleanupState(
    row: { status: string; availableAt: Date; leasedUntil: Date | null },
    at: Date
): OperationState {
    if (row.status === 'FAILED') return 'FAILED';
    if (row.status === 'PENDING')
        return row.availableAt <= at ? 'DUE' : 'SCHEDULED';
    return row.leasedUntil && row.leasedUntil > at ? 'LEASED' : 'EXPIRED';
}

/** Manager-only retained metadata mirrors the lifecycle screen, including deleted originals. */
export async function cleanupPage(
    db: Prisma.TransactionClient,
    actor: RagActor,
    input: OperationsInput,
    at: Date
): Promise<{ items: OperationRow[]; visibleTotal: number }> {
    if (actor.keyId || !permits(actor.permissions, libraryWrite))
        return { items: [], visibleTotal: 0 };
    const where: Prisma.DocumentCleanupWhereInput = {
        AND: [
            cleanupWhere(actor.organizationId, at, input.state),
            {
                version: {
                    document: {
                        name: {
                            contains: literalSearch(input.query),
                            mode: 'insensitive',
                        },
                    },
                },
            },
        ],
    };
    const [items, visibleTotal] = await Promise.all([
        db.documentCleanup.findMany({
            where,
            orderBy: [{ createdAt: 'asc' }, { versionId: 'asc' }],
            skip: input.offset,
            take: input.limit,
            select: {
                versionId: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                availableAt: true,
                leasedUntil: true,
                attempts: true,
                errorCode: true,
                version: {
                    select: {
                        version: true,
                        document: {
                            select: { id: true, name: true, deletedAt: true },
                        },
                    },
                },
            },
        }),
        db.documentCleanup.count({ where }),
    ]);
    return {
        visibleTotal,
        items: items.map((row) => {
            if (row.status === 'COMPLETE')
                throw new ORPCError('SERVICE_UNAVAILABLE');
            return {
                id: row.versionId,
                category: 'DOCUMENT_CLEANUP',
                kind: 'DOCUMENT_CLEANUP',
                status: row.status,
                state: cleanupState(row, at),
                name: row.version.document.name,
                version: row.version.version,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                availableAt: row.availableAt,
                leasedUntil: row.leasedUntil,
                attempts: row.attempts,
                errorCode: row.errorCode,
                targetId: row.version.document.id,
                deleted: Boolean(row.version.document.deletedAt),
            };
        }),
    };
}
