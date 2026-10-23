/** Guarded real service composition. No clients, filesystem, subprocess or connections on import. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createLoadTransport } from './load-transport.mjs';
import { need, LoadRuntimeError } from './load-import-runtime-policy.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The final fetch boundary rechecks sampler safety after SDK serialization/pacing, without an await gap. */
export function createSafeLoadFetch(fetchImpl, assertSafe) {
    need(
        typeof fetchImpl === 'function' && typeof assertSafe === 'function',
        'LOAD_RUNTIME_ADAPTER'
    );
    return (...args) => {
        assertSafe();
        return fetchImpl(...args);
    };
}
/** Real adapters are independently gated; an injected unit test is not permission to construct one. */
export async function createLoadRuntimeServices({
    state,
    fixture,
    statePath,
    runDirectory,
    readCanonical,
    referenceMetadataFields,
    onUnsafe = () => {},
    onEvent = () => {},
    transportMode = 'IMPORT',
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_RUNTIME_DISABLED');
    need(
        ['IMPORT', 'TRAFFIC'].includes(transportMode),
        'LOAD_RUNTIME_ARGUMENTS'
    );
    const { loadObserverGuard, createLoadObservationRuntime } =
        await import('./load-observer-runtime.mjs');
    const { createLoadResourceRuntime } =
        await import('./load-resources-runtime.mjs');
    const { createLoadSizeRuntime } = await import('./load-sizes-runtime.mjs');
    const guarded = async () => loadObserverGuard({ state, statePath });
    await guarded();
    let unsafe = false;
    const markUnsafe = () => {
        unsafe = true;
        onUnsafe(new LoadRuntimeError('LOAD_RUNTIME_RESOURCE_UNSAFE'));
    };
    const assertSafe = () => need(!unsafe, 'LOAD_RUNTIME_RESOURCE_UNSAFE');
    const root = path.resolve(HERE, '../../..'),
        require = createRequire(path.join(root, 'apps/api/package.json'));
    const { createORPCClient } = await import(
        pathToFileURL(require.resolve('@orpc/client')).href
    );
    const { RPCLink } = await import(
        pathToFileURL(require.resolve('@orpc/client/fetch')).href
    );
    const api = createLoadTransport({
        state,
        fixture,
        fetchImpl: createSafeLoadFetch(globalThis.fetch, assertSafe),
        rpcFactory: (options) => createORPCClient(new RPCLink(options)),
        now: () => performance.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        mode: transportMode,
        onEvent,
    });
    const observer = await createLoadObservationRuntime({
        state,
        fixture,
        statePath,
        receiptDirectory: path.join(runDirectory, 'load-native-receipts'),
        readCanonical,
        referenceMetadataFields,
    });
    const beginMeasurements = await createLoadResourceRuntime({
        state,
        fixture,
        statePath,
        directory: path.join(runDirectory, 'load-resource-observations'),
        readProgress: observer.readProgress,
        onUnsafe: markUnsafe,
    });
    const { observeStoreSizes } = await createLoadSizeRuntime({
        state,
        fixture,
        statePath,
        directory: path.join(runDirectory, 'store-sizes'),
    });
    return {
        api,
        observer,
        beginMeasurements,
        observeStoreSizes,
        assertSafe,
        close: () => api.close(),
    };
}
