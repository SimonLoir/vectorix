import assert from 'node:assert/strict';
import {
    embedDocuments,
    type EmbeddingBatch,
    type EmbeddingConfiguration,
    type EmbeddingDocument,
    type EmbeddingResult,
    type ModelIdentity,
} from '../src/index';

/** Check the same public observer contract against each existing native HTTP fixture. */
export async function assertObservedNativeBatches(
    configuration: EmbeddingConfiguration,
    identity: ModelIdentity,
    documents: EmbeddingDocument[]
) {
    const order: string[] = [];
    const completed: { metadata: EmbeddingBatch; result: EmbeddingResult }[] =
        [];
    const result = await embedDocuments(configuration, identity, documents, {
        batchObserver: {
            async beforeBatch(metadata) {
                order.push(`before:${metadata.ordinal}`);
                await Promise.resolve();
            },
            async afterBatch(metadata, batchResult) {
                order.push(`after:${metadata.ordinal}`);
                await Promise.resolve();
                completed.push({ metadata, result: batchResult });
            },
            failedBatch() {
                assert.fail(
                    'Successful native batches must not report a failure.'
                );
            },
        },
    });
    assert(completed.length > 1);
    let offset = 0;
    for (const [
        ordinal,
        { metadata, result: batchResult },
    ] of completed.entries()) {
        assert.equal(metadata.provider, identity.provider);
        assert.equal(metadata.model, identity.model);
        assert.equal(metadata.modelIdentity, identity.digest);
        assert.equal(metadata.kind, 'document');
        assert.equal(metadata.ordinal, ordinal);
        assert.equal(metadata.inputOffset, offset);
        assert.equal(metadata.inputCount, batchResult.vectors.length);
        assert.equal(
            metadata.estimatedInputTokens,
            batchResult.usage.estimatedInputTokens
        );
        assert(metadata.preparedInputBytes > 0);
        assert.equal(
            metadata.preparedInputHashVersion,
            'sha256-json-strings-v1'
        );
        assert.match(metadata.preparedInputHash, /^[a-f0-9]{64}$/);
        assert.equal(batchResult.usage.requests, 1);
        assert(
            batchResult.vectors.every(
                (vector) => vector.length === identity.dimensions
            )
        );
        const serialized = JSON.stringify(metadata);
        assert(!serialized.includes(configuration.endpoint));
        if (configuration.apiKey)
            assert(!serialized.includes(configuration.apiKey));
        offset += metadata.inputCount;
    }
    assert.equal(offset, documents.length);
    assert.equal(result.usage.requests, completed.length);
    assert.deepEqual(
        result.vectors,
        completed.flatMap((entry) => entry.result.vectors)
    );
    assert.equal(
        result.usage.providerInputTokens,
        completed.reduce(
            (sum, entry) => sum + entry.result.usage.providerInputTokens!,
            0
        )
    );
    assert.deepEqual(
        order,
        completed.flatMap(({ metadata }) => [
            `before:${metadata.ordinal}`,
            `after:${metadata.ordinal}`,
        ])
    );
}
