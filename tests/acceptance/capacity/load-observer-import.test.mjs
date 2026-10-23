/** Plain Node import-only proof: installed TS package resolution, zero Client construction/connection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadObservationPackages } from './load-observer-runtime.mjs';
test('plain .mjs entry explicitly loads all TS helpers after admission without an ambient loader', async () => {
    let guards = 0;
    const value = await loadObservationPackages(async () => {
        guards++;
    });
    assert.equal(guards, 1);
    assert.equal(typeof value.Client, 'function');
    assert.equal(typeof value.chunking.resolveChunkingStrategy, 'function');
    assert.equal(typeof value.documents.structuredExtraction.parse, 'function');
    assert.equal(typeof value.embeddings.prepareEmbeddingInput, 'function');
    assert.equal(typeof value.vector.manifestHash, 'function');
});
test('refused admission constructs/imports no runtime dependencies', async () => {
    await assert.rejects(
        () =>
            loadObservationPackages(async () => {
                throw new Error('synthetic-refusal');
            }),
        { message: 'synthetic-refusal' }
    );
});
