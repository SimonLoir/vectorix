import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';

export type NativeRerankRequest = {
    provider: 'COHERE' | 'VOYAGE';
    model: string;
    query: string;
    documents: string[];
};

/** Bounded local native protocol fixture; its deterministic scores do not measure hosted relevance quality. */
export async function createRerankingHttpFixture() {
    const state: {
        calls: NativeRerankRequest[];
        reject: boolean;
        beforeReply?: () => Promise<void>;
        failure?: unknown;
    } = { calls: [], reject: false };
    async function respond(request: IncomingMessage, response: ServerResponse) {
        assert.equal(request.method, 'POST');
        assert.equal(
            request.headers.authorization,
            'Bearer fixture-rerank-key'
        );
        assert(
            state.calls.length < 40,
            'The controlled native fixture has a finite request bound.'
        );
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of request) {
            const chunk: unknown = part;
            assert(chunk instanceof Uint8Array);
            bytes += chunk.byteLength;
            assert(bytes <= 2 * 1024 * 1024);
            parts.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(parts).toString()) as Record<
            string,
            unknown
        >;
        assert.equal(typeof body.model, 'string');
        assert.equal(typeof body.query, 'string');
        assert(
            Array.isArray(body.documents) &&
                body.documents.length > 0 &&
                body.documents.length <= 100
        );
        assert(
            body.documents.every(
                (item): item is string => typeof item === 'string'
            )
        );
        const provider = request.url === '/v2/rerank' ? 'COHERE' : 'VOYAGE';
        assert.equal(
            request.url,
            provider === 'COHERE' ? '/v2/rerank' : '/v1/rerank'
        );
        if (provider === 'COHERE') {
            assert.equal(body.top_n, body.documents.length);
            assert.equal(body.max_tokens_per_doc, 24_000);
        } else {
            assert.equal(body.top_k, body.documents.length);
            assert.equal(body.return_documents, false);
            assert.equal(body.truncation, false);
        }
        const captured: NativeRerankRequest = {
            provider,
            model: body.model as string,
            query: body.query as string,
            documents: [...body.documents],
        };
        state.calls.push(captured);
        await state.beforeReply?.();
        response.setHeader('content-type', 'application/json');
        if (state.reject) {
            response.writeHead(503);
            response.end(
                JSON.stringify({ error: 'PRIVATE_RERANK_PROVIDER_SENTINEL' })
            );
            return;
        }
        const results = captured.documents
            .map((text, index) => ({
                index,
                ['relevance_score']: text.includes('reranktarget')
                    ? 0.95 - index / 10_000
                    : 0.1 + index / 10_000,
            }))
            .toReversed();
        response.end(
            JSON.stringify(
                provider === 'COHERE'
                    ? {
                          results,
                          meta: {
                              tokens: { ['input_tokens']: 13 },
                              ['billed_units']: { ['search_units']: 1 },
                          },
                      }
                    : {
                          object: 'list',
                          model: captured.model,
                          data: results,
                          usage: { ['total_tokens']: 17 },
                      }
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
    const endpoint = `http://127.0.0.1:${address.port}`;
    const previous = process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS;
    process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS = endpoint;
    return {
        endpoint,
        state,
        async close() {
            if (previous === undefined)
                delete process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS;
            else process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS = previous;
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (state.failure) throw state.failure;
        },
    };
}
