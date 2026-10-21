import { Prisma, type PrismaClient } from '@repo/db';

const DEFAULT_MAX_ATTEMPTS = 3;

/** Prisma's pg adapter may expose a commit-time serialization abort before mapping it to P2034. */
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
        cause.originalCode === '40001'
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
 * PostgreSQL may abort a serializable transaction when concurrent booking or
 * payment writes conflict. Prisma reports that case as P2034, so the complete
 * callback is retried with a fresh transaction. Commit-time pg adapter 40001
 * errors are also retried. Callbacks must only contain
 * database work and other safely repeatable operations; external side effects
 * such as payment-provider calls and emails must run after this function.
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
