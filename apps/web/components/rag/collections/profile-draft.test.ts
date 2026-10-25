import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createProfileDraft,
    effectiveProfileDraft,
    recommendedDraft,
    profileDifferences,
    profileFromDraft,
    validateProfileDraft,
} from './profile-draft';

void test('new Simple profile uses explicit Gemma preparation and a valid complete contract', () => {
    const draft = createProfileDraft();
    assert.equal(draft.embeddingPreset, 'EMBEDDING_GEMMA');
    assert.equal(draft.dimensions, '768');
    assert.equal(draft.indexType, 'DISKANN');
    assert.equal(validateProfileDraft(draft), null);
    assert.ok(profileFromDraft(draft).success);
    assert.deepEqual(profileDifferences(draft), []);
});

void test('saved custom and legacy profile values survive draft creation without a reset', () => {
    const parsed = profileFromDraft({
        ...createProfileDraft(),
        embeddingPreset: 'GENERIC',
        targetTokens: '384',
        preparation: 'Saved prefix: ',
        parentChild: true,
        metadataRows: [{ id: 8, key: 'category', type: 'STRING' }],
    });
    assert.ok(parsed.success);
    const draft = createProfileDraft(parsed.data);
    const roundtrip = profileFromDraft(draft);
    assert.ok(roundtrip.success);
    assert.deepEqual(roundtrip.data, parsed.data);
    assert.ok(profileDifferences(draft).includes('targetTokens'));
    assert.ok(profileDifferences(draft).includes('metadataRows'));
});

void test('explicit model recommendations cannot mutate the previous unsaved custom draft', () => {
    const current = {
        ...createProfileDraft(),
        dimensions: '256',
        targetTokens: '384',
        metadataRows: [{ id: 0, key: 'tag', type: 'STRING' as const }],
    };
    const before = structuredClone(current);
    const next = recommendedDraft('OPENAI', 'text-embedding-3-large');
    assert.ok(next);
    assert.equal(next.dimensions, '3072');
    assert.equal(next.indexType, 'DISKANN');
    assert.equal(next.embeddingPreset, 'GENERIC');
    assert.deepEqual(next.metadataRows, []);
    assert.deepEqual(current, before);
    assert.ok(profileDifferences(current).includes('dimensions'));
});

void test('unknown Ollama models have no invented Simple configuration but retain explicit Advanced values', () => {
    assert.equal(recommendedDraft('OLLAMA', 'custom-weights:7'), undefined);
    const draft = {
        ...createProfileDraft(),
        model: 'custom-weights:7',
        dimensions: '1024',
        embeddingPreset: 'GENERIC' as const,
    };
    assert.deepEqual(profileDifferences(draft), ['model']);
    assert.equal(validateProfileDraft(draft), null);
    assert.equal(profileFromDraft(draft).success, true);
});

void test('known hosted dimensions and the physical HNSW limit fail explicitly', () => {
    const draft = recommendedDraft('OPENAI', 'text-embedding-3-large');
    assert.ok(draft);
    assert.equal(validateProfileDraft({ ...draft, indexType: 'HNSW' }), 'hnsw');
    assert.equal(
        validateProfileDraft({ ...draft, dimensions: '3073' }),
        'dimensions'
    );
    assert.equal(
        validateProfileDraft({ ...draft, dimensions: '' }),
        'dimensions'
    );
    assert.equal(
        validateProfileDraft({
            ...draft,
            dimensions: '1536',
            indexType: 'HNSW',
        }),
        null
    );
    assert.equal(
        validateProfileDraft({ ...draft, embeddingPreset: 'EMBEDDING_GEMMA' }),
        'preset'
    );
});

void test('inactive semantic and parent blanks do not block document-structure profiles', () => {
    const draft = {
        ...createProfileDraft(),
        semanticPercentile: '',
        parentMaxTokens: '',
    };
    const result = profileFromDraft(draft);
    assert.ok(result.success);
    assert.equal(result.data.chunking.semanticPercentile, 90);
    assert.equal(result.data.chunking.parentMaxTokens, 2048);
    assert.equal(
        validateProfileDraft({ ...draft, parentMaxTokens: '2048.5' }),
        null
    );
    assert.equal(
        validateProfileDraft({ ...draft, chunkingStrategy: 'SEMANTIC' }),
        'chunking'
    );
    assert.equal(
        validateProfileDraft({ ...draft, parentChild: true }),
        'chunking'
    );
});

void test('valid inactive settings remain unchanged for immutable revision compatibility', () => {
    const draft = {
        ...createProfileDraft(),
        semanticPercentile: '81',
        parentMaxTokens: '4096',
    };
    const result = profileFromDraft(draft);
    assert.ok(result.success);
    assert.equal(result.data.chunking.semanticPercentile, 81);
    assert.equal(result.data.chunking.parentMaxTokens, 4096);
});

void test('metadata duplicates, invalid keys and excessive rows cannot silently collapse through Object.fromEntries', () => {
    const draft = createProfileDraft();
    const row = { id: 0, key: 'valid', type: 'STRING' as const };
    assert.equal(
        validateProfileDraft({
            ...draft,
            metadataRows: [row, { ...row, id: 1 }],
        }),
        'metadata'
    );
    assert.equal(
        validateProfileDraft({
            ...draft,
            metadataRows: [{ ...row, key: 'Invalid key' }],
        }),
        'metadata'
    );
    assert.equal(
        validateProfileDraft({
            ...draft,
            metadataRows: Array.from({ length: 21 }, (_, id) => ({
                ...row,
                id,
                key: `key_${id}`,
            })),
        }),
        'metadata'
    );
    assert.equal(validateProfileDraft({ ...draft, metadataRows: [row] }), null);
});

void test('a lock acquired after editing reviews the same saved profile as submission without erasing the unsaved draft', () => {
    const original = profileFromDraft(createProfileDraft());
    assert.ok(original.success);
    const edited = {
        ...createProfileDraft(original.data),
        targetTokens: '384',
    };
    const lockedReview = effectiveProfileDraft(edited, original.data, true);
    const parsed = profileFromDraft(lockedReview);
    assert.ok(parsed.success);
    assert.deepEqual(parsed.data, original.data);
    assert.equal(edited.targetTokens, '384');
    assert.equal(effectiveProfileDraft(edited, original.data, false), edited);
});
