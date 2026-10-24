import type { PrismaClient } from '@repo/db';
import {
    credentialSecretContext,
    decrypt,
    encrypt,
    needsReencryption,
    pushSubscriptionContext,
} from './encryption';

type CredentialField = 'accessKeyId' | 'secretAccessKey' | 'apiKey';
type Counts = { scanned: number; reencrypted: number; failed: number };
export type ReencryptionReport = Record<string, Counts>;

type Row = Readonly<{
    id: string;
    values: Readonly<Record<string, string | null>>;
    context: (field: string) => string;
}>;

type Column = Readonly<{
    name: string;
    fields: readonly string[];
    load: (cursor: string | undefined, take: number) => Promise<Row[]>;
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
): Column {
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
                take,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
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

function pushColumn(db: PrismaClient): Column {
    return {
        name: 'vectorixPushSubscription',
        fields: ['subscriptionEncrypted'],
        async load(cursor, take) {
            const rows = await db.vectorixPushSubscription.findMany({
                take,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
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

/** Every column that stores `encrypt()` output, with its row binding. */
export function encryptedColumns(db: PrismaClient): Column[] {
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
    ];
}

async function processRow(
    column: Column,
    row: Row,
    counts: Counts,
    dryRun: boolean
) {
    for (const field of column.fields) {
        const value = row.values[field];
        if (!value) continue;
        counts.scanned++;
        if (!needsReencryption(value)) continue;
        try {
            const context = row.context(field);
            const sealed = await encrypt(decrypt(value, context), context);
            if (dryRun || (await column.update(row.id, field, value, sealed)))
                counts.reencrypted++;
        } catch {
            // Undecryptable values stay untouched; they already fail closed on read.
            counts.failed++;
        }
    }
}

/**
 * Re-encrypt legacy and retired-key ciphertexts with the current key and
 * their row binding. Idempotent and resumable: values already sealed with the
 * current key are skipped, and each write compares against the old ciphertext
 * so a concurrent credential update is never overwritten. External I/O is
 * none; each update is a single-row statement outside long transactions.
 */
export async function reencryptStoredSecrets(
    db: PrismaClient,
    { batchSize = 100, dryRun = false } = {}
): Promise<ReencryptionReport> {
    const report: ReencryptionReport = {};
    for (const column of encryptedColumns(db)) {
        const counts = { scanned: 0, reencrypted: 0, failed: 0 };
        report[column.name] = counts;
        let cursor: string | undefined;
        for (;;) {
            const rows = await column.load(cursor, batchSize);
            for (const row of rows)
                await processRow(column, row, counts, dryRun);
            if (rows.length < batchSize) break;
            cursor = rows.at(-1)?.id;
        }
    }
    return report;
}
