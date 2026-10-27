import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { rerank, probeTei } from '../src/index';
import { errorCode, fixture, input, success } from './fixture';
import {
    teiFixture,
    teiInfo,
    teiInput,
    teiModel,
    teiResults,
    teiSnapshot,
} from './tei-fixture';

await test('a refusal after a slow TEI metadata GET retains the caller error identity and sends no candidate POST', async () => {
    const refusal = new Error('owned authority refusal');
    let revoked = false;
    let admissions = 0;
    await teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput,
                    {
                        beforeInference: () => {
                            admissions++;
                            assert(revoked);
                            assert.equal(requests.length, 1);
                            assert.equal(requests[0]!.method, 'GET');
                            return Promise.reject(refusal);
                        },
                    }
                ),
                (error: unknown) => error === refusal
            );
            assert.equal(admissions, 1);
            assert.deepEqual(
                requests.map((request) => request.method),
                ['GET']
            );
        },
        (response) => {
            setTimeout(() => {
                revoked = true;
                response.end(JSON.stringify(teiInfo()));
            }, 25);
        }
    );
});

await test('TEI final admission happens only after a valid matching runtime and immediately before its one POST', async () => {
    const events: string[] = [];
    await teiFixture(
        async (configuration, requests) => {
            const result = await rerank(
                { ...configuration, runtimeSnapshot: teiSnapshot },
                teiInput,
                {
                    beforeInference: async () => {
                        events.push('admission');
                        assert.equal(requests.length, 1);
                        await delay(10);
                        assert.equal(requests.length, 1);
                        events.push('admitted');
                    },
                }
            );
            assert.equal(result.results.length, 3);
            assert.deepEqual(events, ['GET', 'admission', 'admitted', 'POST']);
        },
        (response, request) => {
            events.push(request.method!);
            response.end(
                JSON.stringify(
                    request.method === 'GET' ? teiInfo() : teiResults()
                )
            );
        }
    );
});

await test('failed or changed TEI metadata never invokes final admission', async () => {
    for (const metadata of [teiInfo({ version: 'different' }), {}]) {
        await teiFixture(
            async (configuration, requests) => {
                let admissions = 0;
                await assert.rejects(
                    rerank(
                        { ...configuration, runtimeSnapshot: teiSnapshot },
                        teiInput,
                        {
                            beforeInference: () => {
                                admissions++;
                                return Promise.resolve();
                            },
                        }
                    ),
                    errorCode(
                        'version' in metadata
                            ? 'MODEL_CHANGED'
                            : 'INVALID_PROVIDER_RESPONSE'
                    )
                );
                assert.equal(admissions, 0);
                assert.equal(requests.length, 1);
            },
            (response) => response.end(JSON.stringify(metadata))
        );
    }
});

await test('a metadata-only probe never invokes the inference hook', () =>
    teiFixture(async (configuration, requests) => {
        await probeTei(
            configuration,
            { model: teiModel, candidatePool: 3 },
            {
                beforeInference: () => {
                    assert.fail('A probe cannot admit inference.');
                },
            }
        );
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, 'GET');
    }));

for (const provider of ['COHERE', 'VOYAGE'] as const) {
    const payload = {
        ...input,
        model: provider === 'COHERE' ? input.model : 'rerank-3',
    };
    await test(`${provider} awaits final admission before its only native POST`, async () => {
        const events: string[] = [];
        await fixture(
            provider,
            async (configuration, requests) => {
                await rerank(configuration, payload, {
                    beforeInference: async () => {
                        events.push('admission');
                        assert.equal(requests.length, 0);
                        await delay(10);
                        assert.equal(requests.length, 0);
                        events.push('admitted');
                    },
                });
                assert.deepEqual(events, ['admission', 'admitted', 'POST']);
                assert.equal(requests.length, 1);
            },
            (response, request) => {
                events.push(request.method!);
                response.end(JSON.stringify(success(provider, payload.model)));
            }
        );
    });
    await test(`${provider} preserves a caller admission error without provider conversion or POST`, () =>
        fixture(provider, async (configuration, requests) => {
            const refusal = new Error('owned authority refusal');
            await assert.rejects(
                rerank(configuration, payload, {
                    beforeInference: () => Promise.reject(refusal),
                }),
                (error: unknown) => error === refusal
            );
            assert.equal(requests.length, 0);
        }));
    await test(`${provider} never sends candidate text when final admission exhausts the shared deadline`, () =>
        fixture(provider, async (configuration, requests) => {
            await assert.rejects(
                rerank(configuration, payload, {
                    timeoutMs: 100,
                    beforeInference: async () => {
                        await delay(150);
                    },
                }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 0);
        }));
}

await test('TEI final admission shares the metadata deadline and cannot dispatch after it expires', () =>
    teiFixture(async (configuration, requests) => {
        let admissions = 0;
        await assert.rejects(
            rerank(
                { ...configuration, runtimeSnapshot: teiSnapshot },
                teiInput,
                {
                    timeoutMs: 100,
                    beforeInference: async () => {
                        admissions++;
                        assert.equal(requests.length, 1);
                        await delay(150);
                    },
                }
            ),
            errorCode('PROVIDER_TIMEOUT')
        );
        assert.equal(admissions, 1);
        assert.deepEqual(
            requests.map((request) => request.method),
            ['GET']
        );
    }));

await test('an already cancelled hosted operation does not admit or dispatch inference', () =>
    fixture('COHERE', async (configuration, requests) => {
        const controller = new AbortController();
        controller.abort();
        let admissions = 0;
        await assert.rejects(
            rerank(configuration, input, {
                signal: controller.signal,
                beforeInference: () => {
                    admissions++;
                    return Promise.resolve();
                },
            }),
            errorCode('PROVIDER_TIMEOUT')
        );
        assert.equal(admissions, 0);
        assert.equal(requests.length, 0);
    }));
