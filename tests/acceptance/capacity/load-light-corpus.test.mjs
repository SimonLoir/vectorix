/** Production pure planners and artificial bytes only. No client, DB, native model or service. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    prepareEmbeddingInput,
    embeddingInputByteLimit,
} from '../../../packages/embeddings/src/preparation.ts';
import {
    buildDocument,
    documentSpec,
    planDocument,
    preflight,
    PROFILE,
    PARENT_PROFILE,
    LIMITS,
    MODEL_REQUIREMENT,
    RUNTIME_DRAFT_ONLY,
} from './load-light-corpus.mjs';
import {
    LIVE_IO_DISABLED,
    POLICY_VERSION,
    NAMESPACE,
    CONTROL_PROFILE,
    RESOURCE_LIMITS,
    FINITE_GATES,
    profileForRole,
} from './load-light-policy.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
let savedFull;
const full = () => (savedFull ??= preflight({ documentCount: 200 }));
test('separate policy retains model dimensions CPU limits and finite original gates without implementing live admission', () => {
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    assert.equal(LIVE_IO_DISABLED, true);
    assert.equal(POLICY_VERSION, 'native-light-load-v1');
    assert.equal(NAMESPACE, 'vectorix-m7c-light-load');
    assert.equal(MODEL_REQUIREMENT.dimensions, 768);
    assert.equal(
        MODEL_REQUIREMENT.expectedDigest,
        '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1'
    );
    assert.deepEqual(RESOURCE_LIMITS.ollama, {
        cpus: '4',
        memoryBytes: 6 * 1024 ** 3,
    });
    assert.equal(FINITE_GATES.fullIndexMs / FINITE_GATES.scaleFactor, 144000);
    assert.equal(FINITE_GATES.phaseMicros, 180000000);
    assert.equal(FINITE_GATES.drainMicros, 300000000);
    assert.equal(FINITE_GATES.searchSlots, 10);
});
test('invalid geometry bounds reject before unbounded allocation', () => {
    for (const index of [0, 201, NaN, 1.5])
        assert.throws(() => documentSpec(index));
    for (const children of [0, 501, Infinity, 1.5])
        assert.throws(() => documentSpec(1, children));
    assert.throws(() => planDocument(1, 2, 383));
    assert.throws(() => preflight({ documentCount: 201 }));
    assert.throws(() =>
        preflight({ documentCount: 1, childrenPerDocument: 501 })
    );
});
test('192-byte full records and explicit useful tails solve divisibility without dropping source bytes', () => {
    for (const [count, tail] of [
        [1, 0],
        [2, 144],
        [3, 96],
        [4, 48],
        [500, 48],
    ]) {
        const spec = documentSpec(2, count),
            text = buildDocument(spec),
            bytes = Buffer.from(text);
        assert.equal(spec.bytes, 384 + (count - 1) * 336);
        assert.equal(spec.tailBytes, tail);
        assert.equal(bytes.length, spec.bytes);
        assert.equal(text.split('\n').length - 1, spec.records);
        assert(text.includes('Café cafe\u0301 🧭'));
        assert.equal(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            text
        );
        if (tail) assert(text.trimEnd().includes('LIGHT_END D0002 FR'));
    }
    assert.equal(documentSpec(1).bytes, 168048);
    assert.notEqual(168048 % 192, 0);
});
test('actual light token and parent planners emit 500 children and 125 bounded parents in both languages', () => {
    for (const index of [1, 2]) {
        const planned = planDocument(index);
        assert.equal(planned.rows.length, 500);
        assert.equal(planned.parents.parents.length, 125);
        assert(
            planned.rows
                .at(-1)
                .text.includes(`LIGHT_END D${String(index).padStart(4, '0')}`)
        );
        for (const child of planned.rows) {
            assert.equal(
                child.text,
                planned.text.slice(child.start, child.end)
            );
            assert(Buffer.byteLength(child.text) <= PROFILE.targetTokens * 3);
            assert.equal(
                child.tokenCount,
                Math.ceil(Buffer.byteLength(child.text) / 3)
            );
            assert(child.tokenCountIsEstimate);
            const parent = planned.parents.parents.find(
                (row) =>
                    row.ordinal ===
                    planned.parents.childParentOrdinals[child.ordinal]
            );
            assert(
                Buffer.byteLength(parent.text) <=
                    PARENT_PROFILE.parentMaxTokens * 3
            );
            assert.equal(
                parent.text.slice(
                    child.start - parent.start,
                    child.end - parent.start
                ),
                child.text
            );
        }
        assert.deepEqual(planDocument(index, 500, 384).rows, planned.rows);
    }
});
test('full family proves actual 100k distinct child inputs and canonical totals without native work', () => {
    const result = full();
    assert.equal(result.totals.documents, 200);
    assert.equal(result.totals.children, 100000);
    assert.equal(result.totals.parents, 25000);
    assert.equal(result.totals.sourceBytes, 33609600);
    assert.equal(result.distinctChildTexts, 100000);
    assert.equal(result.distinctPreparedInputs, 100000);
    assert.equal(result.rawFloat32VectorBytesAt768, 307200000);
    assert.equal(result.actualProviderCalls, 0);
    assert.equal(result.capacityAcceptance, 'NOT_RUN');
    assert.notEqual(
        result.corpusSha256,
        'c99db8842d4ab7a52457c8e81926389f7d66b49d569db026ed548fe841f01a67'
    );
});
test('2k pilot is exactly the first four frozen full originals and is a new family rather than changed old hashes', () => {
    const pilot = preflight({ documentCount: 4 }),
        all = full();
    assert.equal(pilot.totals.children, 2000);
    assert.equal(pilot.totals.parents, 500);
    assert.equal(pilot.familySha256, all.familySha256);
    assert.deepEqual(pilot.documents, all.documents.slice(0, 4));
    assert.notEqual(
        pilot.corpusSha256,
        '0d008fd0514aac362e888aa6a582daef1cd0b3feb4cf26e6a3d096faaee0627c'
    );
    assert.notEqual(
        sha(buildDocument(documentSpec(1))),
        '0258ca579f2618ce2f6911ac945b115b18acc8a3e10dff9fe22a9cc0dd9b9745'
    );
});
test('only primary and pilot roles become light while reference and ingestion controls remain original', () => {
    assert.deepEqual(profileForRole('pilotA'), profileForRole('primaryA'));
    for (const role of ['referenceB', 'ingestionA', 'ingestionB'])
        assert.deepEqual(profileForRole(role), CONTROL_PROFILE);
    const local = profileForRole('primaryA');
    local.targetTokens = 1;
    assert.equal(profileForRole('primaryA').targetTokens, 128);
    assert.throws(() => profileForRole('default'));
});
test('native work estimate uses ceil prepared bytes over four and preparation framing needs a fresh actual probe', () => {
    const planned = planDocument(1),
        identity = { preset: 'EMBEDDING_GEMMA', contextTokens: 65536 };
    const sizes = planned.rows.map((row) =>
        Buffer.byteLength(
            prepareEmbeddingInput(identity, 'document', row.text, {
                title: planned.spec.filename,
                preparation: '',
            })
        )
    );
    const result = preflight({ documentCount: 1 });
    assert.equal(
        result.totals.estimatedInputTokens,
        sizes.reduce((sum, bytes) => sum + Math.ceil(bytes / 4), 0)
    );
    assert.equal(
        result.minimumVerifiedContextTokensForPreparedInputs,
        Math.max(...sizes) + 32
    );
    assert(result.minimumVerifiedContextTokensForPreparedInputs < 2048);
    assert(
        embeddingInputByteLimit(
            { preset: 'EMBEDDING_GEMMA', contextTokens: 2048 },
            { kind: 'document', title: planned.spec.filename, preparation: '' }
        ) >=
            PROFILE.targetTokens * 3
    );
    assert.equal(result.httpCalls, 0);
    assert.equal(result.databaseCalls, 0);
});
