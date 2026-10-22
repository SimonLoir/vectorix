import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeEmbeddingBatch } from '../src/batch-observer';
import {
    EmbeddingError,
    type EmbeddingNumericEvent,
    type EmbeddingOptions,
    type OllamaModelIdentity,
} from '../src/types';

const identity: OllamaModelIdentity = {
    schemaVersion: 1,
    provider: 'OLLAMA',
    model: 'fixture:latest',
    digest: 'a'.repeat(64),
    family: 'bert',
    architecture: 'bert',
    contextTokens: 2048,
    defaultDimensions: 3,
    dimensions: 3,
    supportedDimensions: [3],
    capabilities: ['embedding'],
    preset: 'GENERIC',
};
function batch(
    options: EmbeddingOptions,
    signal = new AbortController().signal
) {
    return {
        identity,
        kind: 'document' as const,
        ordinal: 0,
        inputOffset: 0,
        inputs: ['Private input é'],
        options,
        signal,
    };
}
const valid = () =>
    Promise.resolve({
        vectors: [[1, 2, 3]],
        providerInputTokens: 0,
        billedInputTokens: 0,
    });

void test('an accidentally async numeric observer rejection is consumed without awaiting it', async () => {
    const result = await observeEmbeddingBatch(
        batch({
            numericObserver() {
                return Promise.reject(new Error('Discarded async observation'));
            },
        }),
        valid
    );
    assert.deepEqual(result.vectors, [[1, 2, 3]]);
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
});

void test('numeric success carries counts only and cannot alter native result when observation throws', async () => {
    const events: EmbeddingNumericEvent[] = [];
    const result = await observeEmbeddingBatch(
        batch({
            numericObserver(event) {
                events.push(event);
                throw new Error('Discarded observer');
            },
        }),
        valid
    );
    assert.deepEqual(result.vectors, [[1, 2, 3]]);
    assert.deepEqual(
        events.map((event) => event.outcome),
        ['START', 'VALIDATED']
    );
    const last = events[1];
    assert.equal(last?.outcome, 'VALIDATED');
    if (last?.outcome !== 'VALIDATED')
        throw new Error('Expected validated observation.');
    assert.equal(last.providerInputTokens, 0);
    assert.equal(last.billedInputTokens, 0);
    assert.equal(last.validatedVectors, 1);
    assert.equal(last.preparedInputBytes, Buffer.byteLength('Private input é'));
    for (const event of events) {
        assert.ok(Object.isFrozen(event));
        assert.ok(
            !Object.keys(event).some((key) =>
                [
                    'model',
                    'modelIdentity',
                    'preparedInputHash',
                    'text',
                    'vectors',
                    'inputOffset',
                ].includes(key)
            )
        );
    }
});

void test('critical refusal precedes numeric dispatch and native execution', async () => {
    const refusal = new Error('Critical admission refusal');
    let observed = 0,
        called = 0;
    await assert.rejects(
        observeEmbeddingBatch(
            batch({
                numericObserver() {
                    observed++;
                },
                batchObserver: {
                    beforeBatch() {
                        throw refusal;
                    },
                },
            }),
            () => {
                called++;
                return valid();
            }
        ),
        (error) => error === refusal
    );
    assert.equal(observed, 0);
    assert.equal(called, 0);
});

void test('validated late native usage precedes mandatory checkpoint denial without false native failure', async () => {
    const order: string[] = [],
        controller = new AbortController(),
        refusal = new Error('Lease changed');
    await assert.rejects(
        observeEmbeddingBatch(
            batch(
                {
                    numericObserver(event) {
                        order.push(event.outcome);
                    },
                    batchObserver: {
                        beforeBatch() {
                            order.push('BEFORE');
                        },
                        afterBatch() {
                            order.push('AFTER');
                            throw refusal;
                        },
                        failedBatch() {
                            order.push('FAILED_HOOK');
                        },
                    },
                },
                controller.signal
            ),
            () => {
                controller.abort();
                return valid();
            }
        ),
        (error) => error === refusal
    );
    assert.deepEqual(order, ['BEFORE', 'START', 'VALIDATED', 'AFTER']);
});

void test('native failure preserves original exception even when both observation hooks throw', async () => {
    const events: EmbeddingNumericEvent[] = [],
        failure = new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    await assert.rejects(
        observeEmbeddingBatch(
            batch({
                numericObserver(event) {
                    events.push(event);
                    throw new Error('Telemetry');
                },
                batchObserver: {
                    failedBatch() {
                        throw new Error('Settlement callback');
                    },
                },
            }),
            () => Promise.reject(failure)
        ),
        (error) => error === failure
    );
    assert.deepEqual(
        events.map((event) => event.outcome),
        ['START', 'FAILED']
    );
    const final = events[1];
    assert.equal(
        final?.outcome === 'FAILED' ? final.failure : null,
        'INVALID_PROVIDER_RESPONSE'
    );
});

void test('pre-dispatch abort settles critical reservation without claiming a native attempt', async () => {
    const controller = new AbortController();
    controller.abort();
    const order: string[] = [];
    await assert.rejects(
        observeEmbeddingBatch(
            batch(
                {
                    numericObserver(event) {
                        order.push(event.outcome);
                    },
                    batchObserver: {
                        beforeBatch() {
                            order.push('BEFORE');
                        },
                        failedBatch(_metadata, code) {
                            order.push(code);
                        },
                    },
                },
                controller.signal
            ),
            () => {
                order.push('NATIVE');
                return valid();
            }
        ),
        (error) =>
            error instanceof EmbeddingError && error.code === 'PROVIDER_TIMEOUT'
    );
    assert.deepEqual(order, ['BEFORE', 'PROVIDER_TIMEOUT']);
});

void test('logical prefix successes and later failure stay separate; no aggregate usage replay', async () => {
    const events: EmbeddingNumericEvent[] = [],
        options = {
            numericObserver(event: EmbeddingNumericEvent) {
                events.push(event);
            },
        };
    await observeEmbeddingBatch(batch(options), valid);
    await assert.rejects(
        observeEmbeddingBatch(batch(options), () =>
            Promise.reject(new EmbeddingError('PROVIDER_TIMEOUT'))
        )
    );
    assert.deepEqual(
        events.map((event) => event.outcome),
        ['START', 'VALIDATED', 'START', 'FAILED']
    );
});

void test('absent numeric observer retains legacy optional usage and original native vector identity', async () => {
    const vectors = [[1, 0, 0]];
    const result = await observeEmbeddingBatch(batch({}), () =>
        Promise.resolve({
            vectors,
            providerInputTokens: null,
        })
    );
    assert.equal(result.vectors, vectors);
    assert.equal(Object.hasOwn(result.usage, 'billedInputTokens'), false);
});
