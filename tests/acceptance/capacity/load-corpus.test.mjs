/** Pure actual-planner checks. No clients, subprocesses, source files or network calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    documentSpec,
    buildDocument,
    planDocument,
    preflight,
    PROFILE,
    LIMITS,
    RUNTIME_DRAFT_ONLY,
    MODEL_REQUIREMENT,
    TOPICS,
} from './load-corpus.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');

test('hard bounds reject invalid controls before large allocation', () => {
    for (const index of [0, 201, NaN, 1.5])
        assert.throws(() => documentSpec(index), /LOAD_DOCUMENT_BOUND/u);
    for (const count of [0, 501, Infinity, 1.5])
        assert.throws(() => documentSpec(1, count), /LOAD_CHILD_BOUND/u);
    assert.throws(() => planDocument(1, 2, 1535), /LOAD_INPUT_CAP/u);
    assert.throws(
        () => preflight({ documentCount: 201 }),
        /LOAD_DOCUMENT_COUNT/u
    );
    assert.throws(
        () => preflight({ documentCount: 1, childrenPerDocument: 501 }),
        /LOAD_CHILD_BOUND/u
    );
});

test('fixed records produce valid LF UTF-8 English and French including NFD/astral text', () => {
    for (const index of [1, 2]) {
        const spec = documentSpec(index, 3),
            text = buildDocument(spec),
            bytes = Buffer.from(text);
        assert.equal(bytes.length, spec.bytes);
        assert.equal(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            text
        );
        assert.equal(text.includes('\r'), false);
        assert.equal(text.split('\n').length - 1, spec.records);
        if (index === 2) {
            assert.ok(text.includes('Café cafe\u0301 🧭'));
            assert.notEqual(text.length, bytes.length);
            assert.notEqual(hash(text.normalize('NFC')), hash(text));
        }
        assert.ok(bytes.length < LIMITS.sourceBytes);
    }
});

test('real default planner emits exactly500 canonical children and125 bounded parents per document', () => {
    for (const index of [1, 2]) {
        const plan = planDocument(index);
        assert.equal(plan.bytes.length, 672_192);
        assert.equal(
            hash(plan.bytes),
            index === 1
                ? '0258ca579f2618ce2f6911ac945b115b18acc8a3e10dff9fe22a9cc0dd9b9745'
                : '410f9216570a1527feb37f8b368daa17022460d3d33a1e3ead468d08eff0756d'
        );
        assert.equal(plan.rows.length, 500);
        assert.equal(plan.parents.parents.length, 125);
        for (const [ordinal, row] of plan.rows.entries()) {
            assert.equal(row.ordinal, ordinal);
            assert.equal(plan.text.slice(row.start, row.end), row.text);
            assert.equal(Buffer.byteLength(row.text), 1535);
            assert.equal(row.sourceSpans.length, 1);
            assert.equal(row.sourceSpans[0].start, row.start);
            assert.equal(row.sourceSpans[0].end, row.end);
            assert.equal(/[\uD800-\uDBFF]$/u.test(row.text), false);
            assert.equal(/^[\uDC00-\uDFFF]/u.test(row.text), false);
            const parent = plan.parents.parents.find(
                (parent) =>
                    parent.ordinal === plan.parents.childParentOrdinals[ordinal]
            );
            assert.ok(parent);
            assert.equal(
                parent.text.slice(
                    row.start - parent.start,
                    row.end - parent.start
                ),
                row.text
            );
            assert.ok(Buffer.byteLength(parent.text) <= 6144);
        }
    }
});

test('geometry remains identical when verified input cap narrows to exact1536 target bytes', () => {
    for (const index of [1, 2]) {
        const narrow = planDocument(index, 9, 1536),
            wide = planDocument(index, 9);
        assert.deepEqual(narrow.rows, wide.rows);
        assert.deepEqual(narrow.parents, wide.parents);
    }
});

test('byte-identical sources and actual geometry repeat for the same seed', () => {
    const a = preflight({ documentCount: 2, childrenPerDocument: 7 });
    const b = preflight({ documentCount: 2, childrenPerDocument: 7 });
    assert.deepEqual(a, b);
    assert.equal(a.distinctChildTexts, 14);
    assert.equal(a.distinctPreparedInputs, 14);
    assert.equal(a.totals.children, 14);
    assert.notEqual(a.documents[0].sourceSha256, a.documents[1].sourceSha256);
    assert.ok(a.minimumVerifiedContextTokensForPreparedInputs > 1536);
});

test('pilot is a prefix of the same corpus family rather than a separately retuned fixture', () => {
    const pilot = preflight({ documentCount: 4, childrenPerDocument: 3 });
    const extended = preflight({ documentCount: 6, childrenPerDocument: 3 });
    assert.equal(pilot.familySha256, extended.familySha256);
    assert.deepEqual(pilot.documents, extended.documents.slice(0, 4));
    assert.notEqual(pilot.corpusSha256, extended.corpusSha256);
    assert.deepEqual(pilot.languages, { EN: 2, FR: 2 });
});

test('all inputs have distinct real text hashes independently of prepared title variation', () => {
    const output = preflight({ documentCount: 4, childrenPerDocument: 25 });
    assert.equal(output.distinctChildTexts, 100);
    assert.equal(output.distinctPreparedInputs, 100);
    assert.equal(output.totals.children, 100);
    assert.equal(output.totals.workerBatches64, 4);
    assert.ok(
        output.totals.maximumPreparedInputBytes <=
            PROFILE.maxEmbeddingInputBytes
    );
});

test('capacity/provider evidence remains NOT_RUN and full-size model/profile requirements unchanged', () => {
    const proof = preflight({ documentCount: 1, childrenPerDocument: 1 });
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    assert.equal(proof.runtimeDraftOnly, true);
    assert.equal(proof.capacityAcceptance, 'NOT_RUN');
    assert.equal(proof.actualProviderCalls, 0);
    assert.equal(proof.databaseCalls, 0);
    assert.equal(proof.httpCalls, 0);
    assert.equal(MODEL_REQUIREMENT.dimensions, 768);
    assert.equal(MODEL_REQUIREMENT.preset, 'EMBEDDING_GEMMA');
    assert.equal(MODEL_REQUIREMENT.preparation, '');
    assert.equal(TOPICS.length, 8);
    assert.deepEqual(
        [
            PROFILE.targetTokens,
            PROFILE.minTokens,
            PROFILE.maxTokens,
            PROFILE.overlapTokens,
        ],
        [512, 128, 768, 64]
    );
});
