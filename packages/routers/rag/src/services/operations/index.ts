import { ORPCError } from '@orpc/server';
import { Prisma, type PrismaClient } from '@repo/db';
import {
    operationCounts,
    operationItem,
    operationsInput,
} from '@repo/api-contracts/v1/rag/operations';
import {
    ingestionError,
    parserDiagnostic,
} from '@repo/api-contracts/v1/rag/documents';
import { permits } from '@repo/auth/permissions';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor } from '../access';
import { publicIndexFailure } from '../indexing/errors';
import { workRows, pageFilter, visiblePageIds } from './queries';
import { categories, type OperationRow, type OperationsInput } from './types';
import { cleanupCounts, cleanupPage } from './document-cleanup';
import { libraryWrite } from '../documents/access';

type CountRow = {
    category: OperationRow['category'];
    state: OperationRow['state'];
    count: bigint;
    oldestAcceptedAt: Date | null;
};

function safeCount(value: bigint) {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0)
        throw new ORPCError('SERVICE_UNAVAILABLE');
    return count;
}

async function summary(
    db: Prisma.TransactionClient,
    organizationId: string,
    observedAt: Date
) {
    const [scopedRows, originals] = await Promise.all([
        db.$queryRaw<CountRow[]>(Prisma.sql`
        SELECT category,state,count(*) AS count,min("createdAt") AS "oldestAcceptedAt"
        FROM (${Prisma.join(
            categories
                .filter((category) => category !== 'DOCUMENT_CLEANUP')
                .map((category) =>
                    workRows(organizationId, category, observedAt)
                ),
            ' UNION ALL '
        )}) current_work
        GROUP BY category,state
    `),
        cleanupCounts(db, organizationId, observedAt),
    ]);
    const rows = [...scopedRows, ...originals];
    return categories.map((category) => {
        const counts = {
            category,
            uploading: 0,
            due: 0,
            scheduled: 0,
            leased: 0,
            expired: 0,
            failed: 0,
            total: 0,
            oldestAcceptedAt: null as Date | null,
        };
        for (const row of rows.filter((item) => item.category === category)) {
            const state = {
                UPLOADING: 'uploading',
                DUE: 'due',
                SCHEDULED: 'scheduled',
                LEASED: 'leased',
                EXPIRED: 'expired',
                FAILED: 'failed',
            } as const;
            const count = safeCount(row.count);
            counts[state[row.state]] = count;
            counts.total = safeCount(BigInt(counts.total) + row.count);
            if (
                row.oldestAcceptedAt &&
                (!counts.oldestAcceptedAt ||
                    row.oldestAcceptedAt < counts.oldestAcceptedAt)
            )
                counts.oldestAcceptedAt = row.oldestAcceptedAt;
        }
        return operationCounts.parse(counts);
    });
}

function safeError(row: OperationRow) {
    if (!row.errorCode) return null;
    if (row.category === 'INDEXING') return publicIndexFailure(row.errorCode);
    if (row.category === 'DOCUMENT_CLEANUP')
        return row.errorCode === 'STORAGE_UNAVAILABLE'
            ? row.errorCode
            : 'CLEANUP_FAILED';
    const known = ingestionError.safeParse(row.errorCode);
    if (known.success) return known.data;
    const parser = parserDiagnostic.safeParse(row.errorCode);
    return parser.success ? parser.data : 'PROCESSING_FAILED';
}

/** Driver/provider diagnostics never escape this metadata-only read boundary. */
async function sanitized<T>(read: () => Promise<T>): Promise<T> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof ORPCError) throw error;
        throw new ORPCError('SERVICE_UNAVAILABLE', {
            message: 'The operations snapshot is temporarily unavailable.',
        });
    }
}

/**
 * Technical organization counts reveal no names, task IDs or liveness. The caller
 * owns the current superadmin guard; existence is rechecked in this snapshot.
 */
export function getOperationsSummary(db: PrismaClient, organizationId: string) {
    return sanitized(() =>
        db.$transaction(
            async (tx) => {
                if (
                    !(await tx.organization.findUnique({
                        where: { id: organizationId },
                        select: { id: true },
                    }))
                )
                    throw new ORPCError('NOT_FOUND');
                const observedAt = new Date();
                return {
                    observedAt,
                    counts: await summary(tx, organizationId, observedAt),
                };
            },
            { isolationLevel: 'RepeatableRead', timeout: 10_000 }
        )
    );
}

/**
 * Return one consistent technical snapshot and an ACL-filtered page. The final
 * current-access recheck rejects revoked metadata rather than returning stale
 * identifiers; ordinary completion during the read does not revoke visibility.
 */
export function getOperationsOverview(
    context: AuthorizedContext,
    input: OperationsInput
) {
    return sanitized(async () => {
        const page = operationsInput.parse(input);
        const result = await context.db.$transaction(
            async (tx) => {
                const actor = await ragActor(
                    context,
                    tx,
                    { ragQuota: ['read'] },
                    true
                );
                const observedAt = new Date();
                if (page.category === 'DOCUMENT_CLEANUP') {
                    const [counts, details] = await Promise.all([
                        summary(tx, actor.organizationId, observedAt),
                        cleanupPage(tx, actor, page, observedAt),
                    ]);
                    return { observedAt, counts, ...details };
                }
                const rows = workRows(
                    actor.organizationId,
                    page.category,
                    observedAt,
                    actor
                );
                const filter = pageFilter(page);
                const [counts, total, items] = await Promise.all([
                    summary(tx, actor.organizationId, observedAt),
                    tx.$queryRaw<{ count: bigint }[]>(
                        Prisma.sql`SELECT count(*) AS count FROM (${rows}) visible WHERE ${filter}`
                    ),
                    tx.$queryRaw<OperationRow[]>(
                        Prisma.sql`SELECT * FROM (${rows}) visible WHERE ${filter} ORDER BY "createdAt" ASC,id ASC LIMIT ${page.limit} OFFSET ${page.offset}`
                    ),
                ]);
                return {
                    observedAt,
                    counts,
                    items,
                    visibleTotal: safeCount(total[0]?.count ?? 0n),
                };
            },
            { isolationLevel: 'RepeatableRead', timeout: 10_000 }
        );
        const current = await ragActor(
            context,
            context.db,
            { ragQuota: ['read'] },
            true
        );
        if (
            result.items.length &&
            page.category === 'DOCUMENT_CLEANUP' &&
            !permits(current.permissions, libraryWrite)
        )
            throw new ORPCError('FORBIDDEN');
        if (result.items.length && page.category !== 'DOCUMENT_CLEANUP') {
            const visible = await context.db.$queryRaw<{ id: string }[]>(
                visiblePageIds(
                    current,
                    page.category,
                    result.items.map((row) => row.id)
                )
            );
            if (visible.length !== result.items.length)
                throw new ORPCError('FORBIDDEN');
        }
        return {
            ...result,
            items: result.items.map((row) =>
                operationItem.parse({
                    ...row,
                    name: row.name.slice(0, 512),
                    errorCode: safeError(row),
                    target: {
                        type:
                            row.category === 'INDEXING'
                                ? 'COLLECTION'
                                : 'DOCUMENT',
                        id: row.targetId,
                        deleted: row.deleted,
                    },
                })
            ),
        };
    });
}
