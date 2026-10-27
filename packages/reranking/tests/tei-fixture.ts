import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import type { TeiProbeConfiguration, TeiRuntimeSnapshot } from '../src/index';
import { key, type RecordedRequest } from './fixture';

export const teiModel = 'owned/custom-reranker:deployment';
export const teiSnapshot: TeiRuntimeSnapshot = Object.freeze({
    protocolVersion: 'native-tei-v1',
    modelId: teiModel,
    modelRevision: null,
    modelType: 'reranker',
    maxInputLength: 8192,
    maxClientBatchSize: 32,
    runtimeVersion: '1.9.0',
    modelDtype: 'float32',
});
export const teiInput = {
    model: teiModel,
    query: 'Which garden?',
    documents: ['One', 'Two', 'Three'],
};

export function teiInfo(overrides: Record<string, unknown> = {}) {
    return {
        ['model_id']: teiModel,
        ['model_sha']: null,
        ['model_type']: {
            reranker: {
                ['id2label']: { '0': 'LABEL_0' },
                ['label2id']: { LABEL_0: 0 },
            },
        },
        ['max_input_length']: 8192,
        ['max_client_batch_size']: 32,
        ['max_concurrent_requests']: 32,
        ['model_dtype']: 'float32',
        version: '1.9.0',
        ...overrides,
    };
}
export function teiResults(count = 3) {
    return Array.from({ length: count }, (_, index) => ({
        index,
        score: index === 1 ? 0.8 : 0.5,
    })).toReversed();
}

/** Each native TEI test owns one bounded HTTP server and every socket; no model or external service is used. */
export async function teiFixture(
    run: (
        configuration: TeiProbeConfiguration,
        requests: RecordedRequest[]
    ) => Promise<void>,
    respond?: (response: ServerResponse, request: RecordedRequest) => void
) {
    const requests: RecordedRequest[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const part of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(part));
        const body = Buffer.concat(chunks);
        const record: RecordedRequest = {
            method: request.method,
            path: request.url,
            authorization: request.headers.authorization,
            contentType: request.headers['content-type'],
            bytes: body.byteLength,
            body: body.byteLength
                ? (JSON.parse(body.toString()) as Record<string, unknown>)
                : {},
        };
        requests.push(record);
        if (respond) {
            respond(response, record);
            return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
            JSON.stringify(
                record.path === '/info'
                    ? teiInfo()
                    : teiResults((record.body.texts as string[]).length)
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
                provider: 'TEI',
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
