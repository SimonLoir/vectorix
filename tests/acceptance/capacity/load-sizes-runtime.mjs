/** Guarded guarded size adapter. Importing constructs no files, clients, connections or processes. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import {
    createLoadSizeObserver,
    readStoreDatabaseSize,
    LoadSizeError,
} from './load-sizes.mjs';
import {
    loadObserverGuard,
    producerIdentity,
} from './load-observer-runtime.mjs';
import {
    privateDirectory,
    readPrivate,
    privateCheckpoint,
} from './load-private.mjs';
import { validateIdentity } from './load-observer-core.mjs';
import { loadPolicyForState } from './load-policy-registry.mjs';

export const STATIC_DRAFT_ONLY = false;
const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..'
);
const need = (value, code) => {
    if (!value) throw new LoadSizeError(code);
};

/**
 * Only the exact owned load setup can open these PostgreSQL clients. Read-only SQL is the sole
 * measurement; no Docker volume traversal, S3 I/O, business write or environment fallback exists.
 */
export async function createLoadSizeRuntime({
    state,
    fixture,
    statePath,
    directory,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_SIZE_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    const policy = loadPolicyForState(state);
    const runDirectory = path.join(
        ROOT,
        'node_modules/.cache/vectorix',
        policy.namespace + '-' + state.runId
    );
    need(
        statePath === path.join(runDirectory, 'state.json') &&
            directory === path.join(runDirectory, 'store-sizes'),
        'LOAD_SIZE_PATH'
    );
    const admit = async () => {
        try {
            loadObserverGuard({ state, statePath });
            need(
                isDeepStrictEqual(
                    JSON.parse(
                        readPrivate(statePath, 128 * 1024).toString('utf8')
                    ),
                    state
                ),
                'LOAD_SIZE_BINDING'
            );
        } catch (error) {
            if (error instanceof LoadSizeError) throw error;
            throw new LoadSizeError('LOAD_SIZE_GUARD');
        }
    };
    await admit(); // Must precede private sink inspection, module resolution and every client.
    privateDirectory(directory);
    const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
    const { Client } = require('pg');
    const readDatabase = async (kind, input) => {
        await admit();
        const application = kind === 'application';
        const client = new Client({
            connectionString:
                state.environment[
                    application ? 'DATABASE_URL' : 'VECTOR_DATABASE_URL'
                ],
            connectionTimeoutMillis: 5000,
            query_timeout: 6000,
        });
        try {
            await client.connect();
            return await readStoreDatabaseSize(client, {
                database: application
                    ? state.applicationDatabase
                    : state.vectorDatabase,
                experimentPolicyId: policy.id,
                scope: application ? 'public' : 'vector_collections',
                collectionId: application ? input.collectionId : null,
                organizationId: application
                    ? fixture.users.owner.organizationId
                    : null,
            });
        } catch (error) {
            if (error instanceof LoadSizeError) throw error;
            throw new LoadSizeError('LOAD_SIZE_DATABASE');
        } finally {
            await client.end().catch(() => {});
        }
    };
    return createLoadSizeObserver({
        state,
        fixture,
        admit,
        readDatabase,
        producerIdentity: () => producerIdentity(state),
        writeReceipt: async (name, receipt) => {
            need(
                /^store-sizes-(pilot|full)-(before|after)\.json$/u.test(name),
                'LOAD_SIZE_PATH'
            );
            privateCheckpoint(path.join(directory, name), receipt, true);
        },
        evidenceKind: 'LIVE_READ_ONLY',
    });
}
