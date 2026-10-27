import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rerank, probeTei, RERANKING_LIMITS } from '../src/index';
import { errorCode } from './fixture';
import {
    teiFixture,
    teiInfo,
    teiInput,
    teiModel,
    teiResults,
    teiSnapshot,
} from './tei-fixture';

for (const apiKey of ['', ' ', 'bad\r\nkey', 'x'.repeat(8193)]) {
    await test('TEI optional authentication does not accept an invalid configured key', () =>
        teiFixture(async (configuration, requests) => {
            await assert.rejects(
                probeTei(
                    { ...configuration, apiKey },
                    { model: teiModel, candidatePool: 3 }
                ),
                errorCode('INVALID_CONFIGURATION')
            );
            assert.equal(requests.length, 0);
        }));
}

for (const path of ['/info', '/v1/', '/?secret=value', '/#fragment']) {
    await test('TEI uses an exact root endpoint and refuses decorated destinations before GET', () =>
        teiFixture(async (configuration, requests) => {
            await assert.rejects(
                probeTei(
                    {
                        ...configuration,
                        endpoint: configuration.endpoint + path,
                    },
                    { model: teiModel, candidatePool: 3 }
                ),
                errorCode('INVALID_CONFIGURATION')
            );
            assert.equal(requests.length, 0);
        }));
}

for (const phase of ['GET', 'POST']) {
    for (const status of [400, 422, 429, 503]) {
        await test(`TEI ${phase} HTTP ${status} refuses without retries or provider diagnostics`, () =>
            teiFixture(
                async (configuration, requests) => {
                    await assert.rejects(
                        rerank(
                            { ...configuration, runtimeSnapshot: teiSnapshot },
                            teiInput
                        ),
                        errorCode(
                            status === 429 || status >= 500
                                ? 'PROVIDER_UNAVAILABLE'
                                : 'PROVIDER_REJECTED'
                        )
                    );
                    assert.equal(requests.length, phase === 'GET' ? 1 : 2);
                },
                (response, request) => {
                    if (request.method === phase) {
                        response.writeHead(status, { 'retry-after': '0' });
                        response.end('PRIVATE_TEI_PROVIDER_DIAGNOSTICS');
                    } else response.end(JSON.stringify(teiInfo()));
                }
            ));
    }
}

await test('TEI redirects never forward either metadata or inference credentials', () =>
    teiFixture(async (destination, destinationRequests) => {
        for (const phase of ['GET', 'POST']) {
            await teiFixture(
                async (configuration, requests) => {
                    await assert.rejects(
                        rerank(
                            { ...configuration, runtimeSnapshot: teiSnapshot },
                            teiInput
                        ),
                        errorCode('PROVIDER_REJECTED')
                    );
                    assert.equal(requests.length, phase === 'GET' ? 1 : 2);
                    assert.equal(destinationRequests.length, 0);
                },
                (response, request) => {
                    if (request.method === phase) {
                        response.writeHead(307, {
                            location: `${destination.endpoint}/rerank`,
                        });
                        response.end();
                    } else response.end(JSON.stringify(teiInfo()));
                }
            );
        }
    }));

await test('TEI info actual response bytes are bounded before metadata can reach native inference', () =>
    teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput
                ),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
            assert.equal(requests.length, 1);
        },
        (response) => {
            response.writeHead(200);
            response.write('{"padding":"');
            response.end('x'.repeat(RERANKING_LIMITS.responseBytes) + '"}');
        }
    ));

await test('TEI deeply nested info and invalid UTF-8 never reach native inference', async () => {
    for (const body of [
        Buffer.from('['.repeat(17) + '0' + ']'.repeat(17)),
        Buffer.from([0xc3, 0x28]),
    ]) {
        await teiFixture(
            async (configuration, requests) => {
                await assert.rejects(
                    rerank(
                        { ...configuration, runtimeSnapshot: teiSnapshot },
                        teiInput
                    ),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(requests.length, 1);
            },
            (response) => response.end(body)
        );
    }
});

await test('a streamed TEI inference response shares the original deadline', () =>
    teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput,
                    { timeoutMs: 100 }
                ),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 2);
        },
        (response, request) => {
            if (request.path === '/info')
                response.end(JSON.stringify(teiInfo()));
            else {
                response.writeHead(200);
                response.write('[');
            }
        }
    ));

await test('a runtime configured for 100 candidates performs one POST without splitting or truncating UTF-8 text', () =>
    teiFixture(
        async (configuration, requests) => {
            const payload = {
                ...teiInput,
                query: 'é'.repeat(2000),
                documents: Array.from({ length: 100 }, () => 'x'.repeat(1120)),
            };
            const result = await rerank(
                {
                    ...configuration,
                    runtimeSnapshot: {
                        ...teiSnapshot,
                        maxClientBatchSize: 100,
                    },
                },
                payload
            );
            assert.equal(result.results.length, 100);
            assert.equal(requests.length, 2);
            assert.equal(requests[1]!.body.query, payload.query);
            assert.deepEqual(requests[1]!.body.texts, payload.documents);
            assert.equal(requests[1]!.body.truncate, false);
        },
        (response, request) =>
            response.end(
                JSON.stringify(
                    request.path === '/info'
                        ? teiInfo({
                              ['max_client_batch_size']: 100,
                              ['max_concurrent_requests']: 100,
                          })
                        : teiResults(100)
                )
            )
    ));
