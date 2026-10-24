import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const runner = fileURLToPath(
    new URL('../../packages/vector-store/tests/run.sh', import.meta.url)
);

/** Run the real shell entry point with closed, inert process substitutes. */
function execute(t, tcpReadyAfter) {
    const directory = mkdtempSync(join(tmpdir(), 'vectorix-vector-runner-'));
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const events = join(directory, 'events');
    const count = join(directory, 'count');
    writeFileSync(events, '', { mode: 0o600 });
    writeFileSync(count, '0', { mode: 0o600 });
    const scripts = {
        docker: String.raw`#!/bin/bash
set -eu
case "$1" in
    run)
        [[ "$2" == -d && "$3" == --name ]]
        printf 'run %s\n' "$4" >> "$FIXTURE_EVENTS"
        printf 'fixture-container\n'
        ;;
    exec)
        [[ "$3" == pg_isready ]]
        value=$(cat "$FIXTURE_COUNT")
        value=$((value + 1))
        printf '%s' "$value" > "$FIXTURE_COUNT"
        if [[ "$4" != -h ]]; then
            # Simulate the real early Unix-only init server, which is ready now.
            printf 'probe-unix %s\n' "$value" >> "$FIXTURE_EVENTS"
            exit 0
        fi
        [[ "$5" == 127.0.0.1 && "$6" == -U && "$7" == postgres && "$8" == -d && "$9" == vectorix_vector_adapter_test && "$#" == 9 ]]
        printf 'probe-tcp %s\n' "$value" >> "$FIXTURE_EVENTS"
        [[ "$FIXTURE_TCP_AFTER" != 0 && "$value" -ge "$FIXTURE_TCP_AFTER" ]]
        ;;
    port)
        [[ "$3" == 5432/tcp ]]
        printf 'port\n' >> "$FIXTURE_EVENTS"
        printf '127.0.0.1:35432\n'
        ;;
    logs)
        [[ "$2" == --tail && "$3" == 30 ]]
        printf 'logs %s\n' "$4" >> "$FIXTURE_EVENTS"
        ;;
    rm)
        [[ "$2" == -fv ]]
        printf 'cleanup %s\n' "$3" >> "$FIXTURE_EVENTS"
        ;;
    *) exit 64 ;;
esac
`,
        node: String.raw`#!/bin/bash
set -eu
[[ "$#" == 4 && "$1" == --import && "$2" == tsx && "$3" == --test && "$4" == tests/adapter.test.ts ]]
[[ "$VECTOR_ADAPTER_TEST_CONFIG" == *'127.0.0.1:35432/vectorix_vector_adapter_test'* ]]
[[ "$VECTOR_ADAPTER_TEST_ADMIN_URL" == *'127.0.0.1:35432/vectorix_vector_adapter_test' ]]
printf 'native-node\n' >> "$FIXTURE_EVENTS"
`,
        sleep: String.raw`#!/bin/bash
set -eu
[[ "$#" == 1 && "$1" == 1 ]]
printf 'sleep\n' >> "$FIXTURE_EVENTS"
`,
    };
    for (const [name, source] of Object.entries(scripts))
        writeFileSync(join(directory, name), source, { mode: 0o700 });
    const result = spawnSync('/bin/bash', [runner], {
        env: {
            PATH: `${directory}:/usr/bin:/bin`,
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            VECTOR_POSTGRES_IMAGE: 'fixture-only-no-resource',
            FIXTURE_EVENTS: events,
            FIXTURE_COUNT: count,
            FIXTURE_TCP_AFTER: String(tcpReadyAfter),
        },
        timeout: 10_000,
        maxBuffer: 16_384,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.error, undefined);
    const observed = readFileSync(events, 'utf8').trim().split('\n');
    const container = observed[0].slice('run '.length);
    assert.match(container, /^vectorix-m3-adapter-\d+-\d+$/u);
    assert.equal(observed.at(-1), `cleanup ${container}`);
    return { result, observed, container };
}

test('Unix-only startup cannot admit native tests before the final TCP listener', (t) => {
    const { result, observed } = execute(t, 2);
    assert.equal(result.status, 0);
    assert.deepEqual(observed.slice(1, -1), [
        'probe-tcp 1',
        'sleep',
        'probe-tcp 2',
        'port',
        'native-node',
    ]);
    assert.equal(result.stderr, '');
});

test('a ready final TCP server admits exactly one native runner without waiting', (t) => {
    const { result, observed } = execute(t, 1);
    assert.equal(result.status, 0);
    assert.deepEqual(observed.slice(1, -1), [
        'probe-tcp 1',
        'port',
        'native-node',
    ]);
});

test('sixty unsuccessful TCP probes fail finitely before native Node and retain cleanup logs', (t) => {
    const { result, observed, container } = execute(t, 0);
    assert.equal(result.status, 1);
    assert.equal(
        result.stderr,
        'Vector adapter test PostgreSQL TCP readiness timed out.\n'
    );
    assert.equal(
        observed.filter((row) => row.startsWith('probe-tcp ')).length,
        60
    );
    assert.equal(observed.filter((row) => row === 'sleep').length, 59);
    assert.equal(observed.includes('port'), false);
    assert.equal(observed.includes('native-node'), false);
    assert.equal(observed.includes(`logs ${container}`), true);
    assert.equal(
        observed.some((row) => row.startsWith('probe-unix ')),
        false
    );
});
