#!/usr/bin/env node
/** Reviewed runtime: independent exact-resource and private-state guards precede every client. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const STATIC_DRAFT_ONLY = false;

async function main() {
    if (STATIC_DRAFT_ONLY)
        throw new Error('COLLECTOR_STATIC_DRAFT_NOT_EXECUTION_APPROVED');
    const args = process.argv.slice(2);
    if (
        args.length !== 4 ||
        args[0] !== '--state' ||
        args[2] !== '--run' ||
        !/^[a-f0-9]{12}$/u.test(args[3])
    )
        throw new Error('COLLECTOR_ARGUMENTS');
    const {
        discoverWorkspace,
        privateDirectory,
        readPrivate,
        privateCheckpoint,
        guardResources,
        normalApiTransport,
        generationObserver,
    } = await import('./collector-runtime.mjs');
    const { validateQualityState } = await import('./collector-state.mjs');
    const { collectQuality } = await import('./collector-protocol.mjs');
    const { loadFixtures, BASE } = await import('./fixture-loader.mjs');
    const { evaluateCapture } = await import('./evaluate.mjs');
    const directory = path.dirname(fileURLToPath(import.meta.url)),
        root = discoverWorkspace(directory),
        run = args[3];
    const runDirectory = path.join(
        root,
        'node_modules/.cache/vectorix',
        'vectorix-m7c-quality-' + run
    );
    if (args[1] !== path.join(runDirectory, 'state.json'))
        throw new Error('COLLECTOR_EXACT_PRIVATE_STATE');
    privateDirectory(runDirectory);
    const state = JSON.parse(readPrivate(args[1], 128 * 1024)),
        bootstrap = JSON.parse(
            readPrivate(path.join(runDirectory, 'fixture.json'), 128 * 1024)
        );
    validateQualityState(state, bootstrap, run);
    const partial = path.join(runDirectory, 'capture.partial.json'),
        output = path.join(runDirectory, 'capture.json'),
        report = path.join(runDirectory, 'quality-report.json');
    if ([partial, output, report].some((file) => fs.existsSync(file)))
        throw new Error('COLLECTOR_REFUSES_EXISTING_CAPTURE');
    const guarded = () =>
        guardResources(
            root,
            path.join(directory, 'collector-guard.py'),
            args[1],
            run
        );
    guarded(); // Before authentication, RPC/native SDK imports or opening a database.
    const fixtures = await loadFixtures();
    for (const key of Object.keys(process.env))
        if (!['PATH', 'LANG', 'LC_ALL', 'TMPDIR'].includes(key))
            delete process.env[key];
    let transport, observer;
    try {
        transport = await normalApiTransport(root, state, bootstrap);
        await transport.signIn();
        observer = await generationObserver(root, state, guarded);
        const capture = await collectQuality({
            fixtures,
            state,
            bootstrap,
            api: transport,
            originalBytes: async (document) => {
                if (
                    !/^originals\/m7c-[fd]\d{2}-(?:en|fr)-v1\.(?:txt|md|pdf|docx)$/u.test(
                        document.originalPath
                    )
                )
                    throw new Error('COLLECTOR_FIXTURE_ORIGINAL_PATH');
                const filename = path.join(BASE, document.originalPath),
                    actual = fs.realpathSync(filename);
                if (
                    !actual.startsWith(fs.realpathSync(BASE) + path.sep) ||
                    fs.lstatSync(filename).isSymbolicLink() ||
                    fs.statSync(filename).size > 2 * 1024 * 1024
                )
                    throw new Error('COLLECTOR_FIXTURE_ORIGINAL_BOUND');
                return new Uint8Array(fs.readFileSync(filename));
            },
            observeGeneration: (input) => observer.observe(input),
            sleep: (milliseconds) =>
                new Promise((resolve) => setTimeout(resolve, milliseconds)),
            checkpoint: (value) => privateCheckpoint(partial, value),
            evidenceKind: 'LIVE_NATIVE_ISOLATED',
        });
        privateCheckpoint(output, capture, true);
        const evaluated = evaluateCapture(fixtures, capture);
        privateCheckpoint(report, evaluated, true);
        console.log(
            JSON.stringify({
                runId: run,
                status: evaluated.status,
                qualityGatesStatus: evaluated.qualityGatesStatus,
                corpusDigest: evaluated.corpusDigest,
                observedQueryCells: evaluated.observedQueryCells,
                expectedQueryCells: evaluated.expectedQueryCells,
                unscoredSourceProbes:
                    capture.collectionEvidence.unscoredSourceProbeSuccesses,
                sourceProofs: capture.sourceProofs.length,
                hardViolations: evaluated.hardViolations,
                missingEvidence: evaluated.missingEvidence,
                capacityAcceptance: 'NOT_RUN',
                hostedProviderAcceptance: 'NOT_RUN',
            })
        );
        if (evaluated.status !== 'PASS') process.exitCode = 1;
    } finally {
        await observer?.close();
        await transport?.close();
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        const diagnostic =
            typeof error?.message === 'string' &&
            /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
                ? error.message
                : 'COLLECTOR_SANITIZED_REFUSAL';
        console.error(
            JSON.stringify({
                completed: false,
                status: 'NOT_RUN_OR_INCOMPLETE',
                diagnostic,
            })
        );
        process.exitCode = 1;
    });
}
