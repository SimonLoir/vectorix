import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type {
    RerankingConfiguration,
    RerankingInput,
    RerankingProvider,
} from '../src/index';
import { RerankingError } from '../src/index';

export const key = 'owned-test-reranking-secret';
export const input: RerankingInput = {
    model: 'rerank-v5.0-fast',
    query: 'Which garden?',
    documents: ['One', 'Two', 'Three'],
};
export type RecordedRequest = {
    method: string | undefined;
    path: string | undefined;
    authorization: string | undefined;
    contentType: string | undefined;
    bytes: number;
    body: Record<string, unknown>;
};
export type Respond = (
    response: ServerResponse,
    request: RecordedRequest
) => void;

export function success(provider: RerankingProvider, model: string, count = 3) {
    const results = Array.from({ length: count }, (_, index) => ({
        index,
        ['relevance_score']: index === 1 ? 0.8 : 0.5,
    })).toReversed();
    return provider === 'COHERE'
        ? { results }
        : { object: 'list', model, data: results };
}

/** Each test owns its server and all sockets; no external provider or environment is used. */
export async function fixture(
    provider: RerankingProvider,
    run: (
        configuration: RerankingConfiguration,
        requests: RecordedRequest[]
    ) => Promise<void>,
    respond?: Respond
) {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const part of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(part));
        const encoded = Buffer.concat(chunks);
        const record: RecordedRequest = {
            method: request.method,
            path: request.url,
            authorization: request.headers.authorization,
            contentType: request.headers['content-type'],
            bytes: encoded.byteLength,
            body: JSON.parse(encoded.toString('utf8')) as Record<
                string,
                unknown
            >,
        };
        requests.push(record);
        if (respond) {
            respond(response, record);
            return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
            JSON.stringify(
                success(
                    provider,
                    String(record.body.model),
                    (record.body.documents as string[]).length
                )
            )
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
        await run(
            {
                provider,
                endpoint: `http://127.0.0.1:${address.port}`,
                apiKey: key,
            },
            requests
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

export const errorCode = (code: string) => (error: unknown) => {
    assert(error instanceof RerankingError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Reranking operation failed (${code}).`);
    assert(!('cause' in error));
    assert(!('response' in error));
    assert(!error.message.includes(key));
    return true;
};
