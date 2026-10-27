import type { PrismaClient } from '@repo/db';
import {
    assertEncryptionConfiguration,
    credentialSecretContext,
    decrypt,
    encrypt,
    needsReencryption,
    pushSubscriptionContext,
    rerankEndpointSecretContext,
} from './encryption';

type CredentialField = 'accessKeyId' | 'secretAccessKey' | 'apiKey';
export type ReencryptionCounts = {
    scanned: number;
    authenticated: number;
    reencrypted: number;
    wouldReencrypt: number;
    conflicts: number;
    failed: number;
    remaining: number;
    verificationFailed: number;
};
export type ReencryptionReport = Readonly<{
    status: 'COMPLETE' | 'INCOMPLETE' | 'DRY_RUN';
    dryRun: boolean;
    columns: Readonly<Record<string, ReencryptionCounts>>;
}>;

export type ReencryptionRow = Readonly<{
    id: string;
    values: Readonly<Record<string, string | null>>;
    context: (field: string) => string;
}>;

export type ReencryptionColumn = Readonly<{
    name: string;
    fields: readonly string[];
    load: (
        cursor: string | undefined,
        take: number
    ) => Promise<ReencryptionRow[]>;
    /** Compare-and-set on the old ciphertext so concurrent edits win. */
    update: (
        id: string,
        field: string,
        previous: string,
        next: string
    ) => Promise<number>;
}>;

function credentialColumn(
    db: PrismaClient,
    name:
        | 's3Credentials'
        | 'ollamaCredentials'
        | 'cohereCredentials'
        | 'voyageCredentials'
        | 'openAICredentials'
        | 'mistralCredentials',
    fields: readonly CredentialField[]
): ReencryptionColumn {
    // Each delegate has the same id/base/secret-field shape; Prisma cannot express that generically.
    const delegate = db[name] as unknown as {
        findMany: (
            args: unknown
        ) => Promise<
            ({ id: string; base: { organizationId: string } } & Record<
                string,
                string | null
            >)[]
        >;
        updateMany: (args: unknown) => Promise<{ count: number }>;
    };
    return {
        name,
        fields,
        async load(cursor, take) {
            const rows = await delegate.findMany({
                ...reencryptionWindow(cursor, take),
                orderBy: { id: 'asc' },
                select: {
                    id: true,
                    base: { select: { organizationId: true } },
                    ...Object.fromEntries(fields.map((field) => [field, true])),
                },
            });
            return rows.map((row) => ({
                id: row.id,
                values: Object.fromEntries(
                    fields.map((field) => [field, row[field] ?? null])
                ),
                context: (field: string) =>
                    credentialSecretContext(
                        row.base.organizationId,
                        row.id,
                        field as CredentialField
                    ),
            }));
        },
        async update(id, field, previous, next) {
            const result = await delegate.updateMany({
                where: { id, [field]: previous },
                data: { [field]: next },
            });
            return result.count;
        },
    };
}

function pushColumn(db: PrismaClient): ReencryptionColumn {
    return {
        name: 'vectorixPushSubscription',
        fields: ['subscriptionEncrypted'],
        async load(cursor, take) {
            const rows = await db.vectorixPushSubscription.findMany({
                ...reencryptionWindow(cursor, take),
                orderBy: { id: 'asc' },
                select: {
                    id: true,
                    organizationId: true,
                    endpointHash: true,
                    subscriptionEncrypted: true,
                },
            });
            return rows.map((row) => ({
                id: row.id,
                values: { subscriptionEncrypted: row.subscriptionEncrypted },
                context: () =>
                    pushSubscriptionContext(
                        row.organizationId,
                        row.endpointHash
                    ),
            }));
        },
        async update(id, _field, previous, next) {
            const result = await db.vectorixPushSubscription.updateMany({
                where: { id, subscriptionEncrypted: previous },
                data: { subscriptionEncrypted: next },
            });
            return result.count;
        },
    };
}

/** Keep business revision and timestamps intact while fencing concurrent endpoint edits by ciphertext and observed row state. */
function rerankEndpointColumn(db: PrismaClient): ReencryptionColumn {
    return {
        name: 'rerankEndpointCredential',
        fields: ['apiKey'],
        load: async (after, take) => {
            const rows = await db.rerankEndpointCredential.findMany({
                ...reencryptionWindow(after, take),
                orderBy: { id: 'asc' },
                select: { id: true, organizationId: true, apiKey: true },
            });
            return rows.map((row) => ({
                id: row.id,
                values: { apiKey: row.apiKey },
                context: () =>
                    rerankEndpointSecretContext(row.organizationId, row.id),
            }));
        },
        update: async (id, field, previous, next) => {
            if (field !== 'apiKey') throw new Error('Unknown encrypted field.');
            const row = await db.rerankEndpointCredential.findFirst({
                where: { id, apiKey: previous },
                select: { revision: true, updatedAt: true },
            });
            if (!row) return 0;
            const result = await db.rerankEndpointCredential.updateMany({
                where: {
                    id,
                    apiKey: previous,
                    revision: row.revision,
                    updatedAt: row.updatedAt,
                },
                data: { apiKey: next, updatedAt: row.updatedAt },
            });
            return result.count;
        },
    };
}

/** Every column that stores `encrypt()` output, with its row binding. */
export function encryptedColumns(db: PrismaClient): ReencryptionColumn[] {
    return [
        credentialColumn(db, 's3Credentials', [
            'accessKeyId',
            'secretAccessKey',
        ]),
        credentialColumn(db, 'ollamaCredentials', ['apiKey']),
        credentialColumn(db, 'cohereCredentials', ['apiKey']),
        credentialColumn(db, 'voyageCredentials', ['apiKey']),
        credentialColumn(db, 'openAICredentials', ['apiKey']),
        credentialColumn(db, 'mistralCredentials', ['apiKey']),
        pushColumn(db),
        rerankEndpointColumn(db),
    ];
}

/** Keyset reads still advance if the last observed row is deleted concurrently. */
export function reencryptionWindow(after: string | undefined, take: number) {
    return {
        take,
        where: after === undefined ? {} : { id: { gt: after } },
    };
}

async function processRow(
    column: ReencryptionColumn,
    row: ReencryptionRow,
    counts: ReencryptionCounts,
    dryRun: boolean
) {
    for (const field of column.fields) {
        const value = row.values[field];
        if (value === null || value === undefined) continue;
        counts.scanned++;
        try {
            const context = row.context(field);
            // Current-key envelopes must authenticate too; their prefix is not proof.
            const plaintext = decrypt(value, context);
            counts.authenticated++;
            if (!needsReencryption(value)) continue;
            if (dryRun) {
                counts.wouldReencrypt++;
                continue;
            }
            const sealed = await encrypt(plaintext, context);
            const updated = await column.update(row.id, field, value, sealed);
            if (updated === 1) counts.reencrypted++;
            else counts.conflicts++;
        } catch {
            // Only counters escape; an unreadable value is left byte-identical.
            counts.failed++;
        }
    }
}

async function walkColumn(
    column: ReencryptionColumn,
    batchSize: number,
    visit: (row: ReencryptionRow) => Promise<void> | void
) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await column.load(cursor, batchSize);
        if (rows.length > batchSize)
            throw new Error('Invalid re-encryption page.');
        for (const row of rows) await visit(row);
        if (rows.length < batchSize) return;
        const last = rows.at(-1)?.id;
        if (last === undefined || (cursor !== undefined && last <= cursor))
            throw new Error('Invalid re-encryption page.');
        cursor = last;
    }
}

/**
 * Authenticate every value, CAS eligible rewrites, then inspect all values again.
 * No report can establish a future write barrier: retirement additionally requires
 * every writer to use the current key and quiescence throughout verification.
 */
export async function reencryptSecretColumns(
    columns: readonly ReencryptionColumn[],
    { batchSize = 100, dryRun = false } = {}
): Promise<ReencryptionReport> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
        throw new Error(
            'Re-encryption batch size must be an integer from 1 to 1000.'
        );
    assertEncryptionConfiguration();
    const report: Record<string, ReencryptionCounts> = {};
    for (const column of columns) {
        const counts: ReencryptionCounts = {
            scanned: 0,
            authenticated: 0,
            reencrypted: 0,
            wouldReencrypt: 0,
            conflicts: 0,
            failed: 0,
            remaining: 0,
            verificationFailed: 0,
        };
        report[column.name] = counts;
        await walkColumn(column, batchSize, (row) =>
            processRow(column, row, counts, dryRun)
        );
        await walkColumn(column, batchSize, (row) => {
            for (const field of column.fields) {
                const value = row.values[field];
                if (value === null || value === undefined) continue;
                try {
                    decrypt(value, row.context(field));
                    if (needsReencryption(value)) counts.remaining++;
                } catch {
                    counts.verificationFailed++;
                }
            }
        });
    }
    const incomplete = Object.values(report).some(
        (counts) =>
            counts.failed > 0 ||
            counts.conflicts > 0 ||
            counts.verificationFailed > 0 ||
            (!dryRun && counts.remaining > 0)
    );
    return {
        status: incomplete ? 'INCOMPLETE' : dryRun ? 'DRY_RUN' : 'COMPLETE',
        dryRun,
        columns: report,
    };
}

/** Fixed encrypted columns only; no provider I/O, business revision, audit or lifecycle write. */
export function reencryptStoredSecrets(
    db: PrismaClient,
    options: { batchSize?: number; dryRun?: boolean } = {}
): Promise<ReencryptionReport> {
    return reencryptSecretColumns(encryptedColumns(db), options);
}
