import { Prisma, type PrismaClient } from '@repo/db';

const DEFAULT_MAX_ATTEMPTS = 3;

/** Prisma's pg adapter may expose a serialization abort or deadlock before mapping it to P2034. */
export function isSerializationConflict(error: unknown): boolean {
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
    )
        return true;
    if (!(error instanceof Error) || error.name !== 'DriverAdapterError')
        return false;
    const cause = error.cause;
    return (
        typeof cause === 'object' &&
        cause !== null &&
        'kind' in cause &&
        cause.kind === 'TransactionWriteConflict' &&
        'originalCode' in cause &&
        (cause.originalCode === '40001' || cause.originalCode === '40P01')
    );
}

export type SerializableTransactionOptions = Readonly<{
    maxAttempts?: number;
    maxWait?: number;
    timeout?: number;
}>;

/**
 * Runs an interactive Prisma transaction with serializable isolation.
 *
 * PostgreSQL may abort a serializable transaction when concurrent writes
 * conflict. Prisma reports that case as P2034, so the complete
 * callback is retried with a fresh transaction. Typed pg adapter 40001/40P01
 * conflicts are also retried. Callbacks must only contain
 * database work and other safely repeatable operations; external side effects
 * such as provider calls and emails must run after this function.
 */
export async function runSerializableTransaction<T>(
    db: PrismaClient,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options: SerializableTransactionOptions = {}
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
        throw new RangeError('maxAttempts must be a positive integer');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await db.$transaction(operation, {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                ...(options.maxWait === undefined
                    ? {}
                    : { maxWait: options.maxWait }),
                ...(options.timeout === undefined
                    ? {}
                    : { timeout: options.timeout }),
            });
        } catch (error) {
            const isRetryableConflict = isSerializationConflict(error);

            if (!isRetryableConflict || attempt === maxAttempts) {
                throw error;
            }
        }
    }

    throw new Error('Serializable transaction retry loop exhausted');
}
