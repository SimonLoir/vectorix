import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CollectionSchema,
    CollectionIndexAccountingSchema,
    DocumentVersionSchema,
    GenerationDocumentSchema,
    IndexGenerationSchema,
    IndexTaskSchema,
} from '../src/generated/schemas/models';

void test('generated counter defaults are bigint values without coercing decimal strings', () => {
    const counters = [
        CollectionSchema.shape.contentSequence,
        CollectionIndexAccountingSchema.shape.activeChunks,
        CollectionIndexAccountingSchema.shape.retainedChunks,
        CollectionIndexAccountingSchema.shape.reservedChunks,
        CollectionIndexAccountingSchema.shape.revision,
        DocumentVersionSchema.shape.contentFence,
        GenerationDocumentSchema.shape.desiredChangeSequence,
        IndexGenerationSchema.shape.snapshotSequence,
        IndexGenerationSchema.shape.appliedSequence,
        IndexGenerationSchema.shape.projectedChunks,
        IndexTaskSchema.shape.leaseEpoch,
    ];
    for (const counter of counters) {
        assert.equal(counter.parse(undefined), 0n);
        assert.equal(counter.parse(9n), 9n);
        assert.throws(() => counter.parse('9'));
    }
});
