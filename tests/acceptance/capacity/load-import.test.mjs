/** Offline synthetic APIs: localartificialbytes only; native capacity always NOT_RUN. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    prepareLoadBaseline,
    importLoadPilot,
    importLoadFull,
    validatePilotGate,
    RUNTIME_DRAFT_ONLY,
} from './load-import-protocol.mjs';
import {
    LOAD_IDENTITY,
    validateManifest,
    validateReferences,
    importContext,
    LOAD_LIMITS,
} from './load-import-core.mjs';
import { importMock } from './load-import.test-helper.mjs';
async function pilot(options = {}) {
    const io = importMock(options),
        baselineReport = await prepareLoadBaseline(io),
        report = await importLoadPilot({ ...io, baselineReport });
    return { io, baselineReport, report };
}
test('fixedsourcegeometry/referencehashes rejectalteration beforeanymutation', async () => {
    const io = importMock();
    validateManifest(io.manifest);
    validateReferences(io.references);
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    const bad = structuredClone(io.manifest);
    bad.documents[4].topic = 'altered';
    assert.throws(() => validateManifest(bad), { code: 'LOAD_FROZEN_CORPUS' });
    const ref = structuredClone(io.references);
    ref.manifest.documents[0].metadata.region = 'elsewhere';
    assert.throws(() => validateReferences(ref), {
        code: 'LOAD_REFERENCE_CORPUS',
    });
    await assert.rejects(() => importLoadPilot({ ...io, manifest: bad }), {
        code: 'LOAD_FROZEN_CORPUS',
    });
    assert.equal(io.calls.length, 0);
});
test('B24reference andtwoemptyACTIVEingestioncollections precedepilot; explicitreuse addsnobusinessobjects', async () => {
    const io = importMock(),
        baseline = await prepareLoadBaseline(io);
    assert.equal(baseline.status, 'COMPLETE');
    assert.equal(baseline.acceptance, 'NOT_RUN');
    assert.equal(baseline.documents.referenceB.length, 24);
    assert.equal(baseline.collections.ingestionA.activeChildren, 0);
    assert.equal(io.documents.size, 24);
    assert.equal(io.collections.size, 3);
    const reused = await prepareLoadBaseline({
        ...io,
        completedReport: baseline,
    });
    assert.equal(reused.reusedValidatedBaseline, true);
    assert.equal(io.documents.size, 24);
    assert.equal(io.collections.size, 3);
    assert(!JSON.stringify(baseline).includes('PASSWORD'));
});
test('pilotexact4normaluploads+metadata+nativeprobe+new2000generation stayssyntheticNOT_RUN', async () => {
    const { io, report } = await pilot();
    assert.equal(report.documents.loadA.length, 4);
    assert.equal(report.collections.pilot.activeChildren, 2000);
    assert.equal(report.collections.pilot.parents, 500);
    assert.equal(report.acceptance, 'NOT_RUN');
    assert.equal(report.capacityAcceptance, 'NOT_RUN');
    assert.equal(report.corpusSha256, LOAD_IDENTITY.pilot);
    assert.equal(report.pilotObservation.validatedNativeVectors, 2000);
    assert.equal(report.pilotObservation.providerInputTokens, null);
    assert.equal(io.documents.size, 28);
    assert.equal(io.collections.size, 4);
    assert(report.timing.pilotIndexMs > 0);
    assert(report.fullProjectionMs <= 7200000);
    assert(
        io.journals.at(-1).mutations.every((row) => row.status === 'CONFIRMED')
    );
});
test('pilotprojection/resources/nativefailure refusefullbeforeanynewAPIcall', async () => {
    const { io, report } = await pilot(),
        calls = io.calls.length;
    for (const change of [
        (p) => (p.timing.pilotIndexMs = 144001),
        (p) => (p.pilotObservation.minimumFreeBytes = 1),
        (p) => (p.pilotObservation.validatedNativeVectors = 1999),
        (p) => (p.pilotObservation.retries = 1),
        (p) => (p.pilotObservation.errors = 1),
        (p) => (p.status = 'INCOMPLETE'),
        (p) => (p.collections.pilot.activeChildren = 1999),
    ]) {
        const bad = structuredClone(report);
        change(bad);
        await assert.rejects(
            () => importLoadFull({ ...io, pilotReport: bad }),
            { code: 'LOAD_PILOT_ADMISSION' }
        );
    }
    assert.equal(io.calls.length, calls);
});
test('fullusesNEWcollection/generationandall200originals; copyingpilotvectorsorprimarychurnisnotimplemented', async () => {
    const { io, report: prior } = await pilot(),
        full = await importLoadFull({ ...io, pilotReport: prior });
    assert.equal(full.status, 'COMPLETE');
    assert.equal(full.acceptance, 'NOT_RUN');
    assert.equal(full.documents.loadA.length, 200);
    assert.equal(full.collections.primary.activeChildren, 100000);
    assert.equal(full.collections.primary.parents, 25000);
    assert.notEqual(
        full.collections.primary.collectionId,
        prior.collections.pilot.collectionId
    );
    assert.notEqual(
        full.collections.primary.generationId,
        prior.collections.pilot.generationId
    );
    assert.equal(io.documents.size, 224);
    assert.equal(io.collections.size, 5);
    assert.equal(io.nativeBaselines.size, 5);
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        224
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        5
    );
    assert(full.timing.fullIndexMs <= 7200000);
    assert.equal(
        full.baseline.collections.referenceB.generationId,
        prior.baseline.collections.referenceB.generationId
    );
    assert(
        io.calls.every(
            (call) =>
                ![
                    'collections.update',
                    'indexing.retry',
                    'indexing.rebuild',
                    'documents.replace',
                    'documents.delete',
                ].includes(call.operation)
        )
    );
});
test('missingorcontradictoryindependentproofcannotdefaulttoPASS', async () => {
    const io = importMock();
    await assert.rejects(
        () => prepareLoadBaseline({ ...io, observeGeneration: undefined }),
        { code: 'LOAD_OBSERVER_REQUIRED' }
    );
    assert.equal(io.calls.length, 0);
    const bad = importMock({
        observation: (proof) => ({
            ...proof,
            allPhysicalManifestRowsVerified: false,
        }),
    });
    await assert.rejects(() => prepareLoadBaseline(bad), {
        code: 'LOAD_INDEPENDENT_PROOF',
    });
    assert.equal(bad.journals.at(-1).status, 'INCOMPLETE');
});
test('nativeidentity/dimension/contextormetadatadriftstopsbeforestart', async () => {
    for (const change of [
        (v) => ({ ...v, dimensions: 128 }),
        (v) => ({ ...v, digest: 'd'.repeat(64) }),
        (v) => ({ ...v, contextTokens: 1607 }),
    ]) {
        const io = importMock({
            response: ({ operation, value }) =>
                operation === 'indexing.probe' ? change(value) : value,
        });
        await assert.rejects(() => prepareLoadBaseline(io), {
            code: 'LOAD_NATIVE_PROBE',
        });
        assert.equal(
            io.calls.filter((call) => call.operation === 'indexing.start')
                .length,
            0
        );
    }
    const io = importMock({
        response: ({ operation, value }) =>
            operation === 'indexing.documents'
                ? {
                      ...value,
                      items: value.items.map((row) => ({
                          ...row,
                          language: 'UNDETERMINED',
                      })),
                  }
                : value,
    });
    await assert.rejects(() => prepareLoadBaseline(io), {
        code: 'LOAD_METADATA_CHANGED',
    });
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        0
    );
});
test('PENDINGcheckpointprecedesmutation;malformedacceptedresponseisUNKNOWNneverblindlyretried', async () => {
    let io;
    io = importMock({
        beforeCall: ({ operation }) => {
            if (operation === 'documents.upload')
                assert.equal(
                    io.journals.at(-1).mutations.at(-1).status,
                    'PENDING'
                );
        },
        response: ({ operation, value }) =>
            operation === 'documents.upload'
                ? { ...value, id: 'unsafe/id' }
                : value,
    });
    await assert.rejects(
        () => prepareLoadBaseline(io),
        (e) => e.code === 'LOAD_UPLOAD_BINDING' && e.acceptance === 'UNKNOWN'
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        1
    );
    assert.equal(io.journals.at(-1).mutations.at(-1).status, 'PENDING');
    assert.equal(io.journals.at(-1).acceptance, 'UNKNOWN');
    await assert.rejects(
        () => prepareLoadBaseline({ ...io, priorJournal: io.journals.at(-1) }),
        { code: 'LOAD_PARTIAL_REPLAY_REFUSED' }
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        1
    );
});
test('unknown401/429acceptanceorfailedcheckpointremainfiniteandneverreupload', async () => {
    for (const status of [401, 429]) {
        const io = importMock({
            beforeCall: ({ operation }) => {
                if (operation === 'documents.upload')
                    throw Object.assign(new Error('SECRET_RESPONSE'), {
                        status,
                        acceptance: 'UNKNOWN',
                    });
            },
        });
        await assert.rejects(
            () => prepareLoadBaseline(io),
            (e) => e.acceptance === 'UNKNOWN' && !e.message.includes('SECRET')
        );
        assert.equal(
            io.calls.filter((call) => call.operation === 'documents.upload')
                .length,
            1
        );
    }
    const io = importMock({
        checkpoint: () => {
            throw new Error('PRIVATE_PATH_OR_COOKIE');
        },
    });
    await assert.rejects(() => prepareLoadBaseline(io), {
        code: 'LOAD_IMPORT_FAILED',
    });
    assert.equal(io.calls.length, 0);
});
test('wrongcanonicalpagesstopbeforepublicationwithoutpersistingunexpectedtext', async () => {
    const io = importMock({
        response: ({ operation, value }) =>
            operation === 'documents.preview'
                ? { ...value, text: 'SYNTHETIC_WRONG_CANONICAL' }
                : value,
    });
    await assert.rejects(() => prepareLoadBaseline(io));
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        0
    );
    assert(!JSON.stringify(io.journals).includes('SYNTHETIC_WRONG_CANONICAL'));
});
test('oldpilotlibrarycannotberunagainasemptyorsyntheticproofpromotedtolive', async () => {
    const { io, baselineReport, report } = await pilot();
    await assert.rejects(() => importLoadPilot({ ...io, baselineReport }), {
        code: 'LOAD_UNEXPECTED_INVENTORY',
    });
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        28
    );
    const bad = structuredClone(report);
    bad.evidenceKind = 'LIVE_NATIVE_ISOLATED';
    assert.throws(
        () =>
            validatePilotGate(bad, {
                state: io.state,
                evidenceKind: 'SYNTHETIC_UNIT_TEST',
            }),
        { code: 'LOAD_PILOT_ADMISSION' }
    );
});

test('changed resource policy cannot reuse the pilot full projection', async () => {
    const { io, report } = await pilot();
    const calls = io.calls.length;
    const state = structuredClone(io.state);
    state.resourceLimits.ollama.cpus = '2';
    await assert.rejects(
        () => importLoadFull({ ...io, state, pilotReport: report }),
        { code: 'LOAD_PILOT_ADMISSION' }
    );
    assert.equal(io.calls.length, calls);
});
test('expiredpilotsetup stops before further metadata or nativeindex admission', async () => {
    let extra = 0;
    const io = importMock({
            response: ({ operation, value }) => {
                if (
                    operation === 'indexing.updateMetadata' &&
                    extra === 0 &&
                    io.documents.size === 28
                )
                    extra = 1200001;
                return value;
            },
        }),
        baselineReport = await prepareLoadBaseline(io);
    const starts = io.calls.filter(
        (call) => call.operation === 'indexing.start'
    ).length;
    await assert.rejects(
        () =>
            importLoadPilot({
                ...io,
                baselineReport,
                now: () => io.now() + extra,
            }),
        { code: 'LOAD_PHASE_DEADLINE' }
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        starts
    );
});

test('current baseline permission loss refuses pilot before any A upload', async () => {
    let revoked = false;
    const io = importMock({
            response: ({ operation, value }) =>
                operation === 'collections.get' && revoked
                    ? {
                          ...value,
                          permissions: {
                              read: true,
                              manageDocuments: false,
                              administer: false,
                          },
                      }
                    : value,
        }),
        baselineReport = await prepareLoadBaseline(io);
    revoked = true;
    const uploads = io.calls.filter(
        (call) => call.operation === 'documents.upload'
    ).length;
    await assert.rejects(() => importLoadPilot({ ...io, baselineReport }), {
        code: 'LOAD_SAVED_PROFILE',
    });
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        uploads
    );
});

test('BUILDING generation with exact failed task stops promptly while unrelated history is ignored', async () => {
    for (const terminal of [true, false]) {
        const io = importMock({
            response: ({ operation, value, input }) => {
                if (operation !== 'indexing.tasks') return value;
                const generationId = io.collections.get(
                    input.collectionId
                ).generationId;
                return {
                    total: 1,
                    items: [
                        {
                            generationId: terminal
                                ? generationId
                                : 'unrelated-old-generation',
                            status: 'FAILED',
                            stage: 'FAILED',
                            errorCode: 'MODEL_CHANGED',
                        },
                    ],
                };
            },
        });
        if (terminal) {
            await assert.rejects(() => prepareLoadBaseline(io), {
                code: 'LOAD_INDEX_FAILED',
            });
            assert(io.now() < 20000);
            assert.equal(
                io.calls.filter((call) => call.operation === 'indexing.start')
                    .length,
                1
            );
            assert.equal(io.journals.at(-1).status, 'INCOMPLETE');
        } else {
            const report = await prepareLoadBaseline(io);
            assert.equal(report.status, 'COMPLETE');
            assert.equal(report.acceptance, 'NOT_RUN');
        }
    }
});

test('native baseline is required before every normal start and cannot be invented after ACTIVE', async () => {
    const missing = importMock();
    await assert.rejects(
        () =>
            prepareLoadBaseline({
                ...missing,
                beginIndexObservation: undefined,
            }),
        { code: 'LOAD_OBSERVER_REQUIRED' }
    );
    assert.equal(missing.calls.length, 0);
    for (const mutate of [
        (baseline) => ({ ...baseline, stable: false }),
        (baseline) => ({ ...baseline, organizationId: 'another-org' }),
        (baseline) => ({ ...baseline, rawPayload: 'PRIVATE_UNEXPECTED' }),
    ]) {
        const io = importMock({ nativeBaseline: mutate });
        await assert.rejects(() => prepareLoadBaseline(io), {
            code: 'LOAD_NATIVE_BASELINE',
        });
        assert.equal(
            io.calls.filter((call) => call.operation === 'indexing.start')
                .length,
            0
        );
        assert(!JSON.stringify(io.journals).includes('PRIVATE_UNEXPECTED'));
    }
});

test('native counter delta must bind the pre-start baseline with stable complete error-free exclusive evidence', async () => {
    for (const mutate of [
        (native) => ({ ...native, baselineSha256: '0'.repeat(64) }),
        (native) => ({
            ...native,
            nativeStartedBatches: native.nativeBatches + 1,
        }),
        (native) => ({ ...native, knownGapReports: '1' }),
        (native) => ({ ...native, stableFinal: false }),
    ]) {
        const io = importMock({
            observation: (proof) => ({
                ...proof,
                usage: {
                    ...proof.usage,
                    nativeWorkProof: mutate(proof.usage.nativeWorkProof),
                },
            }),
        });
        await assert.rejects(() => prepareLoadBaseline(io), {
            code: 'LOAD_NATIVE_WORK_PROOF',
        });
        assert.equal(io.journals.at(-1).status, 'INCOMPLETE');
    }
    let changed = false;
    const io = importMock({
        observation: (proof) =>
            changed
                ? {
                      ...proof,
                      usage: {
                          ...proof.usage,
                          nativeWorkProof: {
                              ...proof.usage.nativeWorkProof,
                              receiptSha256: '0'.repeat(64),
                          },
                      },
                  }
                : proof,
    });
    const completedReport = await prepareLoadBaseline(io);
    changed = true;
    await assert.rejects(
        () => prepareLoadBaseline({ ...io, completedReport }),
        { code: 'LOAD_NATIVE_WORK_PROOF' }
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'indexing.start').length,
        3
    );
});

test('local source-read delay cannot dispatch another upload after its phase deadline', async () => {
    const io = importMock();
    let extra = 0;
    await assert.rejects(
        () =>
            prepareLoadBaseline({
                ...io,
                now: () => io.now() + extra,
                readOriginal: async (descriptor) => {
                    const bytes = await io.readOriginal(descriptor);
                    extra = 20 * 60 * 1000 + 1;
                    return bytes;
                },
            }),
        { code: 'LOAD_PHASE_DEADLINE' }
    );
    assert.equal(
        io.calls.filter((call) => call.operation === 'documents.upload').length,
        0
    );
});
test('poll interval completes deterministic early wake before one next read without consuming extra polls or calls', async () => {
    const io = importMock(),
        waits = [],
        reads = [],
        advances = [1999, 0, 1, 1999, 0, 1];
    let clock = 0;
    const ctx = importContext({
        ...io,
        workflow: 'pilot',
        now: () => clock,
        sleep: async (requested) => {
            waits.push(requested);
            clock += advances.shift();
        },
    });
    const value = await ctx.wait(
        async () => {
            reads.push(clock);
            return reads.length;
        },
        (count) => count === 3,
        4000
    );
    assert.equal(value, 3);
    assert.deepEqual(reads, [0, 2000, 4000]);
    assert.deepEqual(waits, [2000, 1, 1, 2000, 1, 1]);
    assert.equal(io.calls.length, 0);
});
test('early polling wake never extends the original deadline or issues a read after a wake crosses it', async () => {
    const io = importMock(),
        waits = [],
        reads = [];
    let clock = 0;
    const ctx = importContext({
        ...io,
        workflow: 'pilot',
        now: () => clock,
        sleep: async (requested) => {
            waits.push(requested);
            clock +=
                requested === LOAD_LIMITS.pollMs
                    ? requested - 1
                    : requested + 1;
        },
    });
    await assert.rejects(
        () =>
            ctx.wait(
                async () => {
                    reads.push(clock);
                    return false;
                },
                Boolean,
                2000
            ),
        { code: 'LOAD_PHASE_DEADLINE' }
    );
    assert.deepEqual(reads, [0]);
    assert.deepEqual(waits, [2000, 1]);
    assert.equal(clock, 2001);
    assert.equal(io.calls.length, 0);
});
test('a genuinely frozen polling clock refuses after64local wakes without another read or API call', async () => {
    const io = importMock();
    let sleeps = 0,
        reads = 0;
    const ctx = importContext({
        ...io,
        workflow: 'pilot',
        now: () => 0,
        sleep: async () => {
            sleeps++;
        },
    });
    await assert.rejects(
        () =>
            ctx.wait(
                async () => {
                    reads++;
                    return false;
                },
                Boolean,
                2000
            ),
        { code: 'LOAD_CLOCK_NOT_ADVANCED' }
    );
    assert.equal(sleeps, 64);
    assert.equal(reads, 1);
    assert.equal(io.calls.length, 0);
});
