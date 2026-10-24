/** Hermetic tests of the real independent guard child boundary; no topology or native service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
    createGuardRecheck,
    guardFailure,
    RecipeError,
    scenarioSpec,
} from './private.mjs';
import { executeVectorWorkflow } from './vector-workflow.mjs';
const run = '012345abcdef',
    sourceSha256 = 'a'.repeat(64),
    state = {
        schemaVersion: 1,
        protocolVersion: 2,
        scenario: 'VECTOR_PROVISION_V1',
        namespace: scenarioSpec('VECTOR_PROVISION_V1').namespace,
        runId: run,
        inputs: { helpers: { 'lifecycle.py': sourceSha256 } },
    };
const binding = (purpose = 'observe') => ({
    schemaVersion: 1,
    protocolVersion: 2,
    guardProtocol: 1,
    scenario: state.scenario,
    namespace: state.namespace,
    runId: run,
    purpose,
    sourceSha256,
});
const refused = (purpose = 'observe', stage = 'SCHEMA') => ({
    ...binding(purpose),
    completed: false,
    stage,
    category: 'REFUSED',
});
const child = (value, status = 1) => ({
    status,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: 'PRIVATE diagnostic must never escape',
});
function failure(result, purpose = 'observe') {
    let error;
    try {
        createGuardRecheck(state, purpose, () => result)();
    } catch (value) {
        error = value;
    }
    assert.ok(error instanceof RecipeError);
    assert.equal(error.message, 'M7C_S3_OUTAGE_INDEPENDENT_GUARD');
    assert.equal(
        JSON.stringify(guardFailure(error)).includes('PRIVATE'),
        false
    );
    return error;
}
test('actual recheck preserves strict PASS shape, command/environment caps and monotone vector transition', () => {
    const value = {
        schemaVersion: 1,
        protocolVersion: 2,
        scenario: state.scenario,
        namespace: state.namespace,
        runId: run,
        purpose: 'vector-outage-watch',
        resourceOwnership: true,
        exactTestDatabases: true,
        sourceBuildPins: true,
        vectorTransition: 'UP_PAUSED',
    };
    let calls = 0;
    const recheck = createGuardRecheck(
        state,
        'vector-outage-watch',
        (command, args, options) => {
            calls++;
            assert.equal(command, 'python3');
            assert.deepEqual(args.slice(1), [
                '--run',
                run,
                '--scenario',
                state.scenario,
                '--mode',
                'guard',
                '--purpose',
                'vector-outage-watch',
            ]);
            assert.equal(options.timeout, 15000);
            assert.equal(options.maxBuffer, 16384);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
            assert.equal(Object.hasOwn(options.env, 'DATABASE_URL'), false);
            return child(value, 0);
        }
    );
    assert.deepEqual(recheck(), value);
    value.vectorTransition = 'DOWN_RUNNING';
    assert.deepEqual(recheck(), value);
    value.vectorTransition = 'UP_PAUSED';
    assert.throws(recheck, /S3_OUTAGE_VECTOR_OBSERVER_TRANSITION/u);
    assert.equal(calls, 3);
});
test('every finite child stage is bound and retained without parsing exception contents', () => {
    for (const stage of [
        'ADMISSION',
        'STATE',
        'SOURCE_PINS',
        'STORE_IDENTITY',
        'SCHEMA',
        'PROCESS_IDENTITY',
        'PROCESS_RUNSTATE',
        'SMTP',
        'CONTROL_PHASE',
    ]) {
        const descriptor = guardFailure(
            failure(child(refused('observe', stage)))
        );
        assert.deepEqual(descriptor, {
            ...binding(),
            stage,
            category: 'REFUSED',
            childOutcome: 'NONZERO',
            exitStatus: 1,
        });
        assert.equal(Object.isFrozen(descriptor), true);
    }
    for (const category of ['ERROR', 'INTERRUPTED']) {
        assert.equal(
            guardFailure(failure(child({ ...refused(), category }))).category,
            category
        );
    }
});
test('foreign context and arbitrary/malformed/oversized failure envelopes cannot claim a child stage', () => {
    for (const changed of [
        { sourceSha256: 'b'.repeat(64) },
        { runId: 'bbbbbbbbbbbb' },
        { scenario: 'REDIS_V1' },
        { namespace: 'foreign' },
        { purpose: 'check' },
        { protocolVersion: 1 },
        { guardProtocol: 2 },
        { schemaVersion: 2 },
    ]) {
        const descriptor = guardFailure(
            failure(child({ ...refused(), ...changed }))
        );
        assert.equal(descriptor.stage, 'PROTOCOL');
        assert.equal(descriptor.category, 'CONTEXT_MISMATCH');
    }
    for (const value of [
        null,
        [],
        'PRIVATE',
        { ...refused(), message: 'PRIVATE' },
        { ...refused(), stage: 'PRIVATE' },
        { ...refused(), category: 'PRIVATE' },
        { ...refused(), completed: true },
    ]) {
        assert.equal(
            guardFailure(failure(child(value))).category,
            'INVALID_PROTOCOL'
        );
    }
    for (const stdout of ['{PRIVATE', 'x'.repeat(16385), '']) {
        assert.equal(
            guardFailure(failure({ status: 1, signal: null, stdout })).category,
            'INVALID_PROTOCOL'
        );
    }
    assert.equal(
        guardFailure(failure(child(refused(), 0))).category,
        'INVALID_PROTOCOL'
    );
});
test('timeout, signal, nonzero unknown and hostile child results retain only finite outcomes', () => {
    const timeout = new Error('PRIVATE');
    timeout.code = 'ETIMEDOUT';
    assert.equal(
        guardFailure(
            failure({ status: null, signal: 'SIGTERM', error: timeout })
        ).childOutcome,
        'TIMEOUT'
    );
    assert.equal(
        guardFailure(
            failure({ status: null, signal: 'PRIVATE', stdout: 'PRIVATE' })
        ).childOutcome,
        'SIGNAL'
    );
    assert.equal(
        guardFailure(failure(child({ message: 'PRIVATE' }, 7))).exitStatus,
        7
    );
    const hostile = new Proxy(
        {},
        {
            getOwnPropertyDescriptor() {
                throw new Error('PRIVATE');
            },
        }
    );
    assert.equal(guardFailure(failure(hostile)).childOutcome, 'INVALID_RESULT');
    let touched = 0;
    const accessor = { status: 1 };
    Object.defineProperty(accessor, 'stdout', {
        get() {
            touched++;
            throw new Error('PRIVATE');
        },
    });
    assert.equal(guardFailure(failure(accessor)).category, 'UNKNOWN');
    assert.equal(touched, 0);
    for (const status of [-1, 256, Infinity, '1']) {
        assert.equal(guardFailure(failure({ status })).exitStatus, null);
    }
    const recheck = createGuardRecheck(state, 'observe', () => {
        throw hostile;
    });
    assert.throws(
        recheck,
        (error) => guardFailure(error).childOutcome === 'SPAWN_ERROR'
    );
    assert.equal(
        guardFailure(new RecipeError('M7C_S3_OUTAGE_INDEPENDENT_GUARD')),
        undefined
    );
});
test('actual workflow finalization preserves primary and secondary guard descriptors despite receipt failure', async () => {
    const primary = failure(
            child(refused('staged-observe', 'PROCESS_RUNSTATE')),
            'staged-observe'
        ),
        secondary = failure(
            child(refused('staged-observe', 'SMTP')),
            'staged-observe'
        ),
        finalization = [];
    await assert.rejects(
        executeVectorWorkflow({
            mode: 'rebuild-g2',
            fixture: {
                users: {
                    owner: {
                        userId: 'owner',
                        email: 'owner@example.test',
                        password: 'synthetic',
                    },
                },
                organization: { id: 'org' },
            },
            bindings: { collectionId: 'collection', g1: 'g1', revision: 1 },
            original: Buffer.from('synthetic'),
            request: async (_method, route, body) => {
                if (route.endsWith('sign-in/email'))
                    return { user: { id: 'owner' } };
                if (route.endsWith('get-session'))
                    return {
                        user: { id: 'owner' },
                        session: { activeOrganizationId: 'org' },
                    };
                if (route.endsWith('index-rebuilds')) throw primary;
                if (route.endsWith('sign-out')) {
                    assert.deepEqual(body, {});
                    throw secondary;
                }
                return {};
            },
            recordFinalization: (value) => {
                finalization.push(value);
                throw new Error('PRIVATE receipt');
            },
        }),
        (error) => error === primary
    );
    assert.equal(finalization.length, 1);
    assert.deepEqual(
        finalization[0].primaryGuardFailure,
        guardFailure(primary)
    );
    assert.deepEqual(
        finalization[0].signOutGuardFailure,
        guardFailure(secondary)
    );
    assert.equal(finalization[0].secondarySignOutFailure, true);
    assert.equal(JSON.stringify(finalization).includes('PRIVATE'), false);
});
test('actual Node CLI emits only the finite validated descriptor with compatible generic code', () => {
    const filename = fileURLToPath(new URL('./private.mjs', import.meta.url));
    const code = `import {createGuardRecheck,entryError} from ${JSON.stringify(filename)};
        try { createGuardRecheck(${JSON.stringify(state)},'observe',()=>(${JSON.stringify(child(refused()))}))(); }
        catch(error) {entryError(error);}`;
    const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', code],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), [
        'completed',
        'diagnostic',
        'guardFailure',
    ]);
    assert.equal(output.diagnostic, 'M7C_S3_OUTAGE_INDEPENDENT_GUARD');
    assert.deepEqual(
        output.guardFailure,
        guardFailure(failure(child(refused())))
    );
    assert.equal(result.stdout.includes('PRIVATE'), false);
});

test('actual Python main failure envelope is consumed by the actual Node recheck without native I/O', () => {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const pinnedState = {
        ...state,
        inputs: {
            helpers: {
                'lifecycle.py': createHash('sha256')
                    .update(
                        fs.readFileSync(
                            new URL('./lifecycle.py', import.meta.url)
                        )
                    )
                    .digest('hex'),
            },
        },
    };
    const script = `import sys
sys.path.insert(0, ${JSON.stringify(directory)})
import lifecycle as l
l.STATIC_DRAFT_ONLY=False
l.check_directories=lambda: None
def refused(*args):
    raise l.GuardError('PRIVATE')
l.load=refused
sys.argv=['lifecycle.py','--run','${run}','--scenario','VECTOR_PROVISION_V1','--mode','guard','--purpose','observe']
sys.exit(l.main())
`;
    let calls = 0;
    const recheck = createGuardRecheck(pinnedState, 'observe', () => {
        calls++;
        return spawnSync('python3', ['-B', '-c', script], {
            encoding: 'utf8',
            timeout: 5000,
            maxBuffer: 16384,
        });
    });
    assert.throws(recheck, (error) => {
        assert.deepEqual(guardFailure(error), {
            ...binding(),
            sourceSha256: pinnedState.inputs.helpers['lifecycle.py'],
            stage: 'STATE',
            category: 'REFUSED',
            childOutcome: 'NONZERO',
            exitStatus: 1,
        });
        return true;
    });
    assert.equal(calls, 1);
});
