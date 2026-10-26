import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerank, RERANKING_LIMITS } from '../src/index';
import { fixture, errorCode, input, success } from './fixture';

for (const endpoint of ['/v2', '/v1/', '/?secret=value', '/#fragment']) {
    await test(`configuration rejects a non-root or decorated endpoint (${endpoint}) without HTTP`, () =>
        fixture('COHERE', async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    {
                        ...configuration,
                        endpoint: configuration.endpoint + endpoint,
                    },
                    input
                ),
                errorCode('INVALID_CONFIGURATION')
            );
            assert.equal(requests.length, 0);
        }));
}

for (const apiKey of [
    '',
    '   ',
    'bad\r\nheader',
    'bad\u0000header',
    'x'.repeat(8193),
]) {
    await test('configuration refuses empty, control-bearing and oversized credentials before HTTP', () =>
        fixture('COHERE', async (configuration, requests) => {
            await assert.rejects(
                rerank({ ...configuration, apiKey }, input),
                errorCode('INVALID_CONFIGURATION')
            );
            assert.equal(requests.length, 0);
        }));
}

await test('endpoint credentials and unsupported schemes are sanitized refusals', async () => {
    for (const endpoint of [
        'http://private:secret@127.0.0.1:1',
        'file:///private/credential',
        'not-an-url',
    ]) {
        await assert.rejects(
            rerank({ provider: 'COHERE', endpoint, apiKey: 'test' }, input),
            errorCode('INVALID_CONFIGURATION')
        );
    }
});

for (const timeoutMs of [0, -1, 1.5, 15_001, Number.POSITIVE_INFINITY]) {
    await test('invalid deadline refuses before dispatch', () =>
        fixture('COHERE', async (configuration, requests) => {
            await assert.rejects(
                rerank(configuration, input, { timeoutMs }),
                errorCode('INVALID_CONFIGURATION')
            );
            assert.equal(requests.length, 0);
        }));
}

for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    await test(`HTTP ${status} is sanitized and is not retried even with Retry-After`, () =>
        fixture(
            'COHERE',
            async (configuration, requests) => {
                await assert.rejects(
                    rerank(configuration, input),
                    errorCode(
                        status === 429 || status >= 500
                            ? 'PROVIDER_UNAVAILABLE'
                            : 'PROVIDER_REJECTED'
                    )
                );
                assert.equal(requests.length, 1);
            },
            (response) => {
                response.writeHead(status, { 'retry-after': '0' });
                response.end(
                    'private provider body https://private.example bearer-secret'
                );
            }
        ));
}

await test('redirects never forward a credential or issue a second request', () =>
    fixture('COHERE', async (destination, destinationRequests) => {
        await fixture(
            'COHERE',
            async (configuration, requests) => {
                await assert.rejects(
                    rerank(configuration, input),
                    errorCode('PROVIDER_REJECTED')
                );
                assert.equal(requests.length, 1);
                assert.equal(destinationRequests.length, 0);
            },
            (response) => {
                response.writeHead(307, {
                    location: destination.endpoint + '/v2/rerank',
                });
                response.end();
            }
        );
    }));

await test('an unavailable connection yields only the finite domain error', () =>
    fixture('COHERE', async (_configuration) => {
        await assert.rejects(
            rerank(
                {
                    provider: 'COHERE',
                    endpoint: 'http://127.0.0.1:0',
                    apiKey: 'private-test',
                },
                input
            ),
            errorCode('PROVIDER_UNAVAILABLE')
        );
    }));

await test('pre-aborted cancellation issues no POST and retains no external reason', () =>
    fixture('COHERE', async (configuration, requests) => {
        const controller = new AbortController();
        controller.abort(new Error('private abort reason'));
        await assert.rejects(
            rerank(configuration, input, { signal: controller.signal }),
            errorCode('PROVIDER_TIMEOUT')
        );
        assert.equal(requests.length, 0);
    }));

await test('one deadline expires while waiting for response headers, without retry', () =>
    fixture(
        'COHERE',
        async (configuration, requests) => {
            await assert.rejects(
                rerank(configuration, input, { timeoutMs: 100 }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 1);
        },
        () => {}
    ));

await test('the same deadline also stops a stalled streamed body', () =>
    fixture(
        'COHERE',
        async (configuration, requests) => {
            await assert.rejects(
                rerank(configuration, input, { timeoutMs: 100 }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 1);
        },
        (response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{"results":[');
        }
    ));

await test('external cancellation during a streamed response remains finite and never retries', () =>
    fixture(
        'COHERE',
        async (configuration, requests) => {
            const controller = new AbortController();
            const pending = rerank(configuration, input, {
                signal: controller.signal,
            });
            await new Promise<void>((resolve) => {
                const timer = setInterval(() => {
                    if (requests.length > 0) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 1);
            });
            controller.abort('private cancellation detail');
            await assert.rejects(pending, errorCode('PROVIDER_TIMEOUT'));
            assert.equal(requests.length, 1);
        },
        (response) => {
            response.writeHead(200);
            response.write('{');
        }
    ));

await test('response stream at the exact byte cap is admitted', () =>
    fixture(
        'COHERE',
        async (configuration) => {
            const result = await rerank(configuration, input);
            assert.equal(result.results.length, 3);
        },
        (response) => {
            const base = JSON.stringify({
                ...success('COHERE', input.model),
                padding: '',
            });
            const body = JSON.stringify({
                ...success('COHERE', input.model),
                padding: 'x'.repeat(
                    RERANKING_LIMITS.responseBytes - Buffer.byteLength(base)
                ),
            });
            assert.equal(
                Buffer.byteLength(body),
                RERANKING_LIMITS.responseBytes
            );
            response.writeHead(200);
            response.write(body.slice(0, 100));
            response.end(body.slice(100));
        }
    ));

await test('actual streamed bytes above the cap refuse without relying on Content-Length', () =>
    fixture(
        'COHERE',
        async (configuration, requests) => {
            await assert.rejects(
                rerank(configuration, input),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
            assert.equal(requests.length, 1);
        },
        (response) => {
            response.writeHead(200);
            response.write('{"padding":"');
            response.end(
                '庭'.repeat(Math.ceil(RERANKING_LIMITS.responseBytes / 3)) +
                    '"}'
            );
        }
    ));

await test('an oversized announced response refuses before accepting a tiny body', () =>
    fixture(
        'COHERE',
        async (configuration) => {
            await assert.rejects(
                rerank(configuration, input),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (response) => {
            response.writeHead(200, {
                'content-length': String(RERANKING_LIMITS.responseBytes + 1),
            });
            response.end('{}');
        }
    ));

for (const body of [
    'not JSON secret-body',
    '{"error":"private-provider-error"}',
    '['.repeat(17) + '0' + ']'.repeat(17),
]) {
    await test('malformed, error and excessively nested successful bodies refuse without raw details', () =>
        fixture(
            'COHERE',
            async (configuration) => {
                await assert.rejects(
                    rerank(configuration, input),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (response) => response.end(body)
        ));
}

await test('invalid UTF-8 response bytes are rejected rather than replaced', () =>
    fixture(
        'COHERE',
        async (configuration) => {
            await assert.rejects(
                rerank(configuration, input),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (response) => response.end(Buffer.from([0xc3, 0x28]))
    ));
