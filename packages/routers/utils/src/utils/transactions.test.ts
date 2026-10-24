import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma, prisma } from '@repo/db';
import { ORPCError } from '@orpc/server';
import {
    isSerializationConflict,
    runSerializableTransaction,
} from './transactions';

function driverConflict(code: string, kind = 'TransactionWriteConflict') {
    const error = new Error('private transaction diagnostic', {
        cause: { kind, originalCode: code },
    });
    error.name = 'DriverAdapterError';
    return error;
}
// Node's method mock needs an own descriptor; the real Prisma client is a proxy.
const database = { ...prisma, $transaction: prisma.$transaction };
const knownConflict = () =>
    new Prisma.PrismaClientKnownRequestError('private Prisma diagnostic', {
        code: 'P2034',
        clientVersion: 'fixture',
    });

void test('only known Prisma and typed pg serialization/deadlock errors are retryable', () => {
    for (const error of [
        knownConflict(),
        driverConflict('40001'),
        driverConflict('40P01'),
    ])
        assert.equal(isSerializationConflict(error), true);
    for (const error of [
        null,
        undefined,
        '40001',
        { code: 'P2034' },
        new Error('40001'),
        driverConflict('40002'),
        driverConflict('40P01', 'Other'),
        new ORPCError('CONFLICT'),
    ])
        assert.equal(isSerializationConflict(error), false);
});

for (const [name, makeError] of [
    ['Prisma P2034', knownConflict],
    ['pg serialization 40001', () => driverConflict('40001')],
    ['pg deadlock 40P01', () => driverConflict('40P01')],
] as const) {
    void test(`${name} replays the entire callback and can succeed on the last allowed attempt`, async (t) => {
        let attempts = 0,
            callbacks = 0;
        const options: unknown[] = [];
        t.mock.method(
            database,
            '$transaction',
            async (
                operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
                configuration: unknown
            ) => {
                attempts++;
                options.push(configuration);
                const result = await operation(prisma);
                if (attempts < 3) throw makeError(); // Model a commit-time abort after the callback.
                return result;
            }
        );
        const result = await runSerializableTransaction(
            database,
            (tx) => {
                assert.equal(tx, prisma);
                return Promise.resolve(++callbacks);
            },
            { maxWait: 1234, timeout: 5678 }
        );
        assert.equal(result, 3);
        assert.equal(attempts, 3);
        assert.equal(callbacks, 3);
        assert.deepEqual(
            options,
            Array.from({ length: 3 }, () => ({
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
                maxWait: 1234,
                timeout: 5678,
            }))
        );
    });
    void test(`${name} stops after three attempts and preserves the final conflict`, async (t) => {
        let attempts = 0,
            callbacks = 0;
        const failure = makeError();
        t.mock.method(
            database,
            '$transaction',
            async (
                operation: (tx: Prisma.TransactionClient) => Promise<unknown>
            ) => {
                attempts++;
                await operation(prisma);
                throw failure;
            }
        );
        await assert.rejects(
            runSerializableTransaction(database, () =>
                Promise.resolve(++callbacks)
            ),
            (error) => error === failure
        );
        assert.equal(attempts, 3);
        assert.equal(callbacks, 3);
    });
}

void test('a smaller explicit bound is honored and invalid bounds never enter a transaction', async (t) => {
    let attempts = 0;
    const failure = driverConflict('40P01');
    t.mock.method(database, '$transaction', () => {
        attempts++;
        return Promise.reject(failure);
    });
    await assert.rejects(
        runSerializableTransaction(database, () => Promise.resolve('unused'), {
            maxAttempts: 2,
        }),
        (error) => error === failure
    );
    assert.equal(attempts, 2);
    for (const maxAttempts of [0, -1, 1.5, Number.NaN])
        await assert.rejects(
            runSerializableTransaction(
                database,
                () => Promise.resolve('unused'),
                {
                    maxAttempts,
                }
            ),
            RangeError
        );
    assert.equal(attempts, 2);
});

void test('unrelated failures and domain refusals are never retried', async (t) => {
    for (const failure of [
        new Error('private unknown'),
        new ORPCError('CONFLICT'),
        driverConflict('23505'),
    ]) {
        let attempts = 0;
        const mocked = t.mock.method(database, '$transaction', () => {
            attempts++;
            return Promise.reject(failure);
        });
        try {
            await assert.rejects(
                runSerializableTransaction(database, () =>
                    Promise.resolve('unused')
                ),
                (error) => error === failure
            );
            assert.equal(attempts, 1);
        } finally {
            mocked.mock.restore();
        }
    }
});
