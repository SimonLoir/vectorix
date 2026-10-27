import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';

export const teiModel = 'BAAI/bge-reranker-v2-m3';

/** Owned native TEI protocol only; deterministic scores and reported revisions do not attest to model weights or quality. */
export async function createTeiRerankingFixture() {
    const state: {
        infoCalls: number;
        calls: { query: string; texts: string[] }[];
        model: string;
        revision: string;
        maxInputLength: number;
        maxClientBatchSize: number;
        maxConcurrentRequests: number;
        tokens: number | null;
        apiKey: string | null;
        beforeInfo?: () => Promise<void>;
        beforeReply?: () => Promise<void>;
        failure?: unknown;
    } = {
        infoCalls: 0,
        calls: [],
        model: teiModel,
        revision: 'a'.repeat(40),
        maxInputLength: 8192,
        maxClientBatchSize: 32,
        maxConcurrentRequests: 32,
        tokens: 23,
        apiKey: null,
    };
    async function respond(request: IncomingMessage, response: ServerResponse) {
        assert(
            state.infoCalls + state.calls.length < 160,
            'Controlled TEI request bound exceeded.'
        );
        assert.equal(
            request.headers.authorization,
            state.apiKey === null ? undefined : `Bearer ${state.apiKey}`
        );
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET' && request.url === '/info') {
            state.infoCalls++;
            await state.beforeInfo?.();
            response.end(
                JSON.stringify({
                    ['model_id']: state.model,
                    ['model_sha']: state.revision,
                    ['model_type']: {
                        reranker: {
                            ['id2label']: { 0: 'relevance' },
                            ['label2id']: { relevance: 0 },
                        },
                    },
                    ['max_input_length']: state.maxInputLength,
                    ['max_client_batch_size']: state.maxClientBatchSize,
                    ['max_concurrent_requests']: state.maxConcurrentRequests,
                    version: '1.9.4',
                    ['model_dtype']: 'float32',
                })
            );
            return;
        }
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/rerank');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request as AsyncIterable<Uint8Array>) {
            bytes += chunk.byteLength;
            assert(bytes <= 2 * 1024 * 1024);
            chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8')
        ) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).toSorted(), [
            'query',
            'raw_scores',
            'return_text',
            'texts',
            'truncate',
        ]);
        assert.equal(typeof body.query, 'string');
        assert.equal(body.truncate, false);
        assert.equal(body.raw_scores, false);
        assert.equal(body.return_text, false);
        assert(
            Array.isArray(body.texts) &&
                body.texts.length > 0 &&
                body.texts.length <= 32
        );
        assert(
            body.texts.every((text): text is string => typeof text === 'string')
        );
        assert(body.texts.length <= state.maxConcurrentRequests);
        const captured = {
            query: body.query as string,
            texts: [...body.texts],
        };
        state.calls.push(captured);
        await state.beforeReply?.();
        if (state.tokens !== null)
            response.setHeader('x-compute-tokens', String(state.tokens));
        response.end(
            JSON.stringify(
                captured.texts
                    .map((text, index) => ({
                        index,
                        score: text.includes('prioritypassage')
                            ? 0.95 - index / 10_000
                            : 0.1 + index / 10_000,
                    }))
                    .toReversed()
            )
        );
    }
    const server = createServer((request, response) => {
        void respond(request, response).catch((error: unknown) => {
            state.failure = error;
            response.writeHead(500);
            response.end('{}');
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    return {
        endpoint: `http://127.0.0.1:${address.port}`,
        state,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (state.failure) throw state.failure;
        },
    };
}
