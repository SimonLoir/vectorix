/** Injected normal-API protocol only; no native service, network, DB, Docker or process operation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { importMock } from './load-import.test-helper.mjs';
import {
    prepareLoadBaseline,
    importLoadPilot,
    importLoadFull,
    validatePilotGate,
} from './load-import-protocol.mjs';
import {
    getLoadPolicy,
    policySha256,
    profileForCollectionRole,
} from './load-policy-registry.mjs';

async function lightPilot(options = {}) {
    const io = importMock({ experimentPolicyId: 'LIGHT_V1', ...options });
    const baselineReport = await prepareLoadBaseline(io);
    const report = await importLoadPilot({ ...io, baselineReport });
    return { io, baselineReport, report };
}

test('light baseline controls remain512 while the normal four-source pilot uses128 and exact explicit receipts', async () => {
    const { io, baselineReport, report } = await lightPilot();
    const policy = getLoadPolicy('LIGHT_V1');
    assert.equal(report.experimentPolicyId, policy.id);
    assert.equal(report.policySha256, policySha256(policy));
    assert.equal(report.corpusSha256, policy.identity.pilot);
    for (const collectionRole of ['referenceB', 'ingestionA', 'ingestionB']) {
        const collection = baselineReport.collections[collectionRole];
        assert.equal(collection.collectionRole, collectionRole);
        assert.equal(collection.policySha256, policySha256(policy));
        assert.equal(collection.profile.chunking.targetTokens, 512);
        assert.equal(collection.profile.chunking.parentMaxTokens, 2048);
        assert.equal(collection.nativeBaseline.collectionRole, collectionRole);
        assert.equal(
            collection.observation.nativeWorkProof.collectionRole,
            collectionRole
        );
    }
    assert.equal(report.collections.pilot.collectionRole, 'pilotA');
    assert.deepEqual(
        report.collections.pilot.profile,
        profileForCollectionRole(policy, 'pilotA')
    );
    assert.equal(
        report.collections.pilot.profile.chunking.parentMaxTokens,
        512
    );
    assert.equal(report.collections.pilot.activeChildren, 2000);
    assert.equal(report.collections.pilot.parents, 500);
    assert.equal(
        io.manifest.documents.slice(0, 4).reduce((n, doc) => n + doc.bytes, 0),
        672192
    );
    assert.equal(report.acceptance, 'NOT_RUN');
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
    assert.equal(io.nativeBaselines.size, 4);
});

test('light full creates a new normal generation with all200 originals, no pilot vector adoption or changed controls', async () => {
    const { io, report: pilot } = await lightPilot();
    const full = await importLoadFull({ ...io, pilotReport: pilot });
    assert.equal(full.documents.loadA.length, 200);
    assert.equal(full.collections.primary.activeChildren, 100000);
    assert.equal(full.collections.primary.parents, 25000);
    assert.equal(full.collections.primary.collectionRole, 'primaryA');
    assert.equal(full.collections.primary.profile.chunking.targetTokens, 128);
    assert.notEqual(
        full.collections.primary.generationId,
        pilot.collections.pilot.generationId
    );
    assert.equal(
        full.baseline.collections.referenceB.profile.chunking.targetTokens,
        512
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        224
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        5
    );
    assert.equal(
        io.manifest.documents.reduce((n, doc) => n + doc.bytes, 0),
        33609600
    );
    assert.equal(full.acceptance, 'NOT_RUN');
});

test('cross-policy state, corpus and completed pilot reject without a new API call', async () => {
    const light = getLoadPolicy('LIGHT_V1');
    const wrongState = importMock({ experimentPolicyId: 'LIGHT_V1' });
    wrongState.state.experimentPolicySha256 = policySha256(
        getLoadPolicy('DEFAULT_V1')
    );
    await assert.rejects(() => prepareLoadBaseline(wrongState));
    assert.equal(wrongState.calls.length, 0);
    const io = importMock({ experimentPolicyId: 'LIGHT_V1' });
    const defaultCorpus = importMock().manifest;
    await assert.rejects(() =>
        importLoadPilot({ ...io, manifest: defaultCorpus })
    );
    assert.equal(io.calls.length, 0);
    const { io: live, report } = await lightPilot();
    const before = live.calls.length;
    for (const mutate of [
        (p) => {
            p.policySha256 = policySha256(getLoadPolicy('DEFAULT_V1'));
        },
        (p) => {
            p.collections.pilot.collectionRole = 'primaryA';
        },
        (p) => {
            p.timing.pilotIndexMs = 144001;
        },
    ]) {
        const invalid = structuredClone(report);
        mutate(invalid);
        await assert.rejects(() =>
            importLoadFull({ ...live, pilotReport: invalid })
        );
    }
    assert.equal(live.calls.length, before);
    const valid = structuredClone(report);
    valid.timing.pilotIndexMs = 144000;
    assert.equal(
        validatePilotGate(valid, {
            state: live.state,
            evidenceKind: 'SYNTHETIC_UNIT_TEST',
        }).policySha256,
        policySha256(light)
    );
});

test('light refuses a too-small fresh native probe and cross-role normalized native evidence', async () => {
    const insufficient = importMock({
        experimentPolicyId: 'LIGHT_V1',
        response: ({ operation, value }) =>
            operation === 'indexing.probe'
                ? { ...value, contextTokens: 1607 }
                : value,
    });
    await assert.rejects(() => prepareLoadBaseline(insufficient));
    assert.equal(
        insufficient.calls.filter((call) => call.operation === 'indexing.start')
            .length,
        0
    );
    for (const observation of [
        (proof) => ({ ...proof, collectionRole: 'ingestionB' }),
        (proof) => ({
            ...proof,
            usage: {
                ...proof.usage,
                nativeWorkProof: {
                    ...proof.usage.nativeWorkProof,
                    collectionRole: 'ingestionB',
                },
            },
        }),
        (proof) => ({
            ...proof,
            policySha256: policySha256(getLoadPolicy('DEFAULT_V1')),
        }),
    ]) {
        const io = importMock({ experimentPolicyId: 'LIGHT_V1', observation });
        await assert.rejects(() => prepareLoadBaseline(io));
        assert.equal(io.journals.at(-1).status, 'INCOMPLETE');
    }
});

test('light A context457 is derived separately from the unchanged1608 control prerequisite', async () => {
    for (const [contextTokens, accepted] of [
        [457, true],
        [456, false],
    ]) {
        let probes = 0;
        const io = importMock({
            experimentPolicyId: 'LIGHT_V1',
            response: ({ operation, value }) => {
                if (operation !== 'indexing.probe') return value;
                return ++probes === 4 ? { ...value, contextTokens } : value;
            },
        });
        const baselineReport = await prepareLoadBaseline(io);
        if (accepted) {
            const report = await importLoadPilot({ ...io, baselineReport });
            assert.equal(report.collections.pilot.activeChildren, 2000);
        } else {
            await assert.rejects(() =>
                importLoadPilot({ ...io, baselineReport })
            );
            assert.equal(
                io.calls.filter((call) => call.operation === 'indexing.start')
                    .length,
                3
            );
        }
    }
});
