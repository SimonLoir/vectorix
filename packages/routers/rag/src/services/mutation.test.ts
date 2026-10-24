import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORPCError } from '@orpc/server';
import { Prisma } from '@repo/db';
import { normalizeCatalogMutationError } from './mutation';

function driverConflict(code: string, kind = 'TransactionWriteConflict') {
    const error = new Error('PRIVATE_DRIVER_SENTINEL', {
        cause: {
            kind,
            originalCode: code,
            privateMetadata: 'PRIVATE_DRIVER_SENTINEL',
        },
    });
    error.name = 'DriverAdapterError';
    return error;
}
function prismaError(code: string) {
    return new Prisma.PrismaClientKnownRequestError('PRIVATE_DRIVER_SENTINEL', {
        code,
        clientVersion: 'fixture',
        meta: { privateMetadata: 'PRIVATE_DRIVER_SENTINEL' },
    });
}

void test('exhausted recognized transaction conflicts become safe domain CONFLICT responses', () => {
    for (const source of [
        prismaError('P2034'),
        driverConflict('40001'),
        driverConflict('40P01'),
    ]) {
        const error = normalizeCatalogMutationError(source);
        assert.ok(error instanceof ORPCError);
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.status, 409);
        assert.equal(
            error.message,
            'The resource changed. Reload before retrying.'
        );
        assert.equal(error.cause, undefined);
        assert.equal(error.data, undefined);
        assert.ok(!JSON.stringify(error).includes('PRIVATE_DRIVER_SENTINEL'));
    }
});

void test('existing constraint mapping is retained and unrelated failures preserve their identity', () => {
    for (const code of ['P2002', 'P2003', 'P2014', 'P2025']) {
        const error = normalizeCatalogMutationError(prismaError(code));
        assert.ok(error instanceof ORPCError);
        assert.equal(error.code, 'CONFLICT');
        assert.equal(
            error.message,
            'The resource changed, already exists, or is still referenced.'
        );
    }
    for (const error of [
        new ORPCError('FORBIDDEN'),
        new ORPCError('CONFLICT'),
        new Error('PRIVATE_DRIVER_SENTINEL'),
        prismaError('P2010'),
        driverConflict('40P01', 'Other'),
        driverConflict('23505'),
        null,
        '40001',
    ])
        assert.equal(normalizeCatalogMutationError(error), error);
});
