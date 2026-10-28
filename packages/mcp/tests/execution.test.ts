import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createExecutor, MAX_OUTPUT_BYTES } from '../src/execution';

await test('oversized whole output is refused without partial content or native exception disclosure', async () => {
    const run = createExecutor();
    const signal = new AbortController().signal;
    const oversized = await run(signal, () =>
        Promise.resolve({ text: 'x'.repeat(MAX_OUTPUT_BYTES) })
    );
    assert.deepEqual(oversized, {
        isError: true,
        content: [{ type: 'text', text: 'OUTPUT_TOO_LARGE' }],
    });
    const failure = await run(signal, () =>
        Promise.reject(new Error('query secret password provider-response'))
    );
    assert.deepEqual(failure, {
        isError: true,
        content: [{ type: 'text', text: 'API_REQUEST_FAILED' }],
    });
});

await test('two active calls exhaust local concurrency and capacity is released after completion', async () => {
    const run = createExecutor();
    const signal = new AbortController().signal;
    const release = Promise.withResolvers<void>();
    let started = 0;
    const operation = async () => {
        started++;
        await release.promise;
        return {};
    };
    const first = run(signal, operation);
    const second = run(signal, operation);
    const refused = await run(signal, operation);
    assert.equal(started, 2);
    assert.deepEqual(refused, {
        isError: true,
        content: [{ type: 'text', text: 'SERVER_BUSY' }],
    });
    release.resolve();
    await Promise.all([first, second]);
    const accepted = await run(signal, () => Promise.resolve({}));
    assert.ok(!('isError' in accepted));
});

await test('the complete operation shares one deadline and aborted work cannot return content', async () => {
    const run = createExecutor(10);
    const outcome = await run(new AbortController().signal, async (signal) => {
        await setTimeout(1000, undefined, { signal });
        return { text: 'late-content' };
    });
    assert.deepEqual(outcome, {
        isError: true,
        content: [{ type: 'text', text: 'REQUEST_CANCELLED_OR_TIMED_OUT' }],
    });
});
