import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    parseReencryptionArguments,
    runReencryptionCommand,
} from './secret-reencryption-command';
import type { ReencryptionReport } from './secret-reencryption';

function report(status: ReencryptionReport['status']): ReencryptionReport {
    return {
        status,
        dryRun: status === 'DRY_RUN',
        columns: {
            cohereCredentials: {
                scanned: 1,
                authenticated: 1,
                reencrypted: 0,
                wouldReencrypt: status === 'DRY_RUN' ? 1 : 0,
                conflicts: status === 'INCOMPLETE' ? 1 : 0,
                failed: 0,
                remaining: 0,
                verificationFailed: 0,
            },
        },
    };
}
void test('only exact closed CLI arguments admit an operation; help and typos do not import or execute a client', async () => {
    assert.deepEqual(parseReencryptionArguments([]), { dryRun: false });
    assert.deepEqual(parseReencryptionArguments(['--dry-run']), {
        dryRun: true,
    });
    let calls = 0;
    const lines: string[] = [];
    const errors: string[] = [];
    const dependencies = {
        execute: () => {
            calls++;
            return Promise.resolve(report('COMPLETE'));
        },
        write: (line: string) => lines.push(line),
        error: (line: string) => errors.push(line),
    };
    assert.equal(await runReencryptionCommand(['--help'], dependencies), 0);
    assert.equal(calls, 0);
    assert.equal(lines.length, 1);
    for (const args of [
        ['--dryrun'],
        ['--dry-run', '--dry-run'],
        ['--help', '--dry-run'],
        ['private-argument-sentinel'],
    ])
        assert.equal(await runReencryptionCommand(args, dependencies), 1);
    assert.equal(calls, 0);
    assert.ok(!errors.join('\n').includes('private-argument-sentinel'));
});
void test('unexpected operation failures expose one static diagnostic without raw error fields', async () => {
    const privateValue = 'private-operation-cause-sentinel';
    const lines: string[] = [];
    const errors: string[] = [];
    assert.equal(
        await runReencryptionCommand([], {
            execute: () =>
                Promise.reject(
                    new Error(privateValue, {
                        cause: { database: privateValue },
                    })
                ),
            write: (line) => lines.push(line),
            error: (line) => errors.push(line),
        }),
        1
    );
    assert.deepEqual(lines, []);
    assert.equal(errors.length, 1);
    assert.ok(!errors[0]!.includes(privateValue));
    assert.equal(
        errors[0],
        'Secret re-encryption failed. Check configuration and database availability; no completion is established.'
    );
});
void test('incomplete reports refuse success, dry runs remain distinct and every result qualifies retirement', async () => {
    for (const status of ['COMPLETE', 'INCOMPLETE', 'DRY_RUN'] as const) {
        const lines: string[] = [];
        const errors: string[] = [];
        let observedDryRun: boolean | undefined;
        const exit = await runReencryptionCommand(
            status === 'DRY_RUN' ? ['--dry-run'] : [],
            {
                execute: ({ dryRun }) => {
                    observedDryRun = dryRun;
                    return Promise.resolve(report(status));
                },
                write: (line) => lines.push(line),
                error: (line) => errors.push(line),
            }
        );
        assert.equal(exit, status === 'INCOMPLETE' ? 1 : 0);
        assert.equal(observedDryRun, status === 'DRY_RUN');
        assert.ok(lines.includes(`Re-encryption status: ${status}`));
        assert.ok(
            lines
                .at(-1)
                ?.includes(
                    'all writers to use the current key and no concurrent writes'
                )
        );
        assert.deepEqual(errors, []);
    }
});
