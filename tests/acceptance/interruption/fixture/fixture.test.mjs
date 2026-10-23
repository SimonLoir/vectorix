/** Local synthetic text and production pure parsers/planners only; no native service or model is called. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    buildBlock,
    buildSource,
    FILE_NAME,
    UNIT_COUNT,
    UNIT_TARGET_BYTES,
    PROFILE,
    PREPARATION_CONTRACT,
} from './fixture.mjs';
import {
    createPreflight,
    loadProduction,
    validateSuppliedProbe,
    sha,
    main,
    readOwnedFile,
    verifyPreparedOutputs,
} from './preflight.mjs';
const modules = await loadProduction();
test('deterministic 128 prose blocks are long varied useful UTF8 with only blank-line boundaries', () => {
    const source = buildSource(),
        blocks = source.trimEnd().split('\n\n');
    assert.equal(source, buildSource());
    assert.equal(blocks.length, UNIT_COUNT);
    assert.equal(new Set(blocks.map(sha)).size, UNIT_COUNT);
    for (const [ordinal, block] of blocks.entries()) {
        assert.equal(block, buildBlock(ordinal));
        assert(!/[.!?。！？\r\n\0]/u.test(block));
        assert(Buffer.byteLength(block) >= 1790);
        assert(Buffer.byteLength(block) <= UNIT_TARGET_BYTES);
    }
    assert(Buffer.byteLength(source) < 25 * 1024 ** 2);
    assert.throws(() => buildBlock(128));
});
test('actual worker text extraction and production unitizer preserve all 128 exact canonical ranges and prepared hashes', () => {
    const { original, artifact, proof } = createPreflight(modules);
    assert.equal(proof.unitCount, UNIT_COUNT);
    assert.equal(proof.sourceSha256, sha(original));
    assert.equal(proof.canonicalSha256, sha(artifact.text));
    assert.equal(proof.offsetUnit, 'UTF16_CODE_UNITS');
    assert.equal(
        proof.identityEvidence,
        'EXPLICIT_PREPARATION_CONTRACT_NOT_NATIVE_IDENTITY'
    );
    assert.equal(proof.nativeAcceptance, 'NOT_RUN');
    assert.equal(proof.nativeTiming, 'UNMEASURED');
    assert.equal(
        proof.usefulTextByteCap,
        modules.embeddings.embeddingInputByteLimit(PREPARATION_CONTRACT, {
            title: FILE_NAME,
            preparation: '',
        })
    );
    for (const unit of proof.units) {
        const text = artifact.text.slice(unit.start, unit.end);
        assert.equal(sha(text), unit.textSha256);
        assert.equal(
            sha(
                modules.embeddings.prepareEmbeddingInput(
                    PREPARATION_CONTRACT,
                    'document',
                    text,
                    { title: FILE_NAME, preparation: '' }
                )
            ),
            unit.preparedInputSha256
        );
    }
    assert.equal(
        new Set(proof.units.map((unit) => unit.preparedInputSha256)).size,
        UNIT_COUNT
    );
});
test('six synthetic distance scenarios validate both percentile profiles and parent 2048 without claiming native geometry', () => {
    const { proof } = createPreflight(modules);
    assert.deepEqual(proof.profile, PROFILE);
    assert.equal(proof.geometryCases.length, 6);
    assert.deepEqual(
        [...new Set(proof.geometryCases.map((entry) => entry.percentile))],
        [90, 55]
    );
    for (const entry of proof.geometryCases) {
        assert.equal(entry.scoreEvidence, 'SYNTHETIC_NOT_NATIVE');
        assert(
            entry.children > 0 && entry.children <= 5000 && entry.parents > 0
        );
        assert(/^[a-f0-9]{64}$/u.test(entry.planHash));
        assert(
            entry.maximumChildPreparedBytes <=
                PREPARATION_CONTRACT.contextTokens - 32
        );
    }
});
test('public fixture check accepts clone-like 0755 directory and 0644 files while private probe reader still refuses them', () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-interruption-public-')
    );
    try {
        const file = path.join(directory, 'synthetic.json');
        fs.chmodSync(directory, 0o755);
        fs.writeFileSync(file, '{}', { mode: 0o644 });
        const outputs = { 'synthetic.json': Buffer.from('{}') };
        verifyPreparedOutputs(directory, outputs);
        assert.throws(() => readOwnedFile(file, 8), /FIXTURE_REFUSED/u);
        fs.chmodSync(file, 0o666);
        assert.throws(
            () => verifyPreparedOutputs(directory, outputs),
            /FIXTURE_REFUSED/u
        );
        fs.chmodSync(file, 0o644);
        fs.chmodSync(directory, 0o777);
        assert.throws(
            () => verifyPreparedOutputs(directory, outputs),
            /FIXTURE_REFUSED/u
        );
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
test('supplied probe gate requires the real title-adjusted preparation budget and preserves unproven provenance', () => {
    const probe = {
        provider: 'OLLAMA',
        model: 'embeddinggemma:latest',
        digest: 'a'.repeat(64),
        contextTokens: 2048,
        preset: 'EMBEDDING_GEMMA',
        dimensions: 128,
    };
    const accepted = validateSuppliedProbe(modules, probe);
    assert.equal(accepted.unitCount, UNIT_COUNT);
    assert.equal(accepted.provenance, 'NOT_PROBED_BY_THIS_TOOL');
    assert(accepted.usefulTextByteCap >= accepted.maximumUnitBytes);
    for (const change of [
        { contextTokens: 1024 },
        { preset: 'GENERIC' },
        { provider: 'OPENAI' },
        { dimensions: 42 },
        { digest: 'not-a-native-digest' },
    ])
        assert.throws(() =>
            validateSuppliedProbe(modules, { ...probe, ...change })
        );
    assert(
        modules.embeddings.embeddingInputByteLimit(PREPARATION_CONTRACT, {
            title: 'a'.repeat(200),
            preparation: '',
        }) < accepted.usefulTextByteCap
    );
});
test('invalid CLI modes refuse before a generation, probe read or provider operation', async () => {
    for (const args of [
        [],
        ['generate', '--overwrite'],
        ['connect'],
        ['check-probe'],
    ])
        await assert.rejects(() => main(args), /FIXTURE_REFUSED/u);
});
test('local proof reader bounds actual bytes and refuses oversized files, symlinks and public modes', () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-interruption-fixture-')
    );
    try {
        const file = path.join(directory, 'proof.json'),
            link = path.join(directory, 'link.json');
        fs.writeFileSync(file, '12345678', { mode: 0o600 });
        assert.equal(readOwnedFile(file, 8).toString(), '12345678');
        assert.throws(() => readOwnedFile(file, 7), /FIXTURE_REFUSED/u);
        fs.symlinkSync(file, link);
        assert.throws(() => readOwnedFile(link, 8));
        fs.chmodSync(file, 0o644);
        assert.throws(() => readOwnedFile(file, 8), /FIXTURE_REFUSED/u);
        assert.throws(() => readOwnedFile(file, 0), /FIXTURE_REFUSED/u);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
