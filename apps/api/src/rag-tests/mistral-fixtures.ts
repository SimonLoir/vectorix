import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const MISTRAL_ORGANIZATION_KEY = 'mistral-organization-synthetic-key';
export const MISTRAL_PLATFORM_KEY = 'mistral-platform-synthetic-key';
export const MISTRAL_ROTATED_KEY = 'mistral-rotated-synthetic-key';
export const MISTRAL_PROXY_PREFIX = '/approved-proxy/v1';

type MistralBody = {
    input?: string[];
    model?: string;
    dimensions?: number;
    encoding_format?: string;
    input_type?: string;
    truncation?: boolean;
    output_dimension?: number;
};

/** Native Mistral HTTP with synthetic vectors; reversing indexed rows tests passage association, never model quality. */
export async function createMistralHttpFixture() {
    const state: {
        calls: {
            path: string;
            method: string | undefined;
            authorization: string | undefined;
            body: MistralBody;
        }[];
        rejectEmbeddings: boolean;
        invalidDimensions: boolean;
        invalidIndex: boolean;
        duplicateIndex: boolean;
        responseModel: string;
        unreviewedCatalog: boolean;
        beforeEmbedding?: () => Promise<void>;
        beforeModels?: () => Promise<void>;
    } = {
        calls: [],
        rejectEmbeddings: false,
        invalidDimensions: false,
        invalidIndex: false,
        duplicateIndex: false,
        responseModel: 'mistral-embed-2312',
        unreviewedCatalog: false,
    };
    const keys = new Set([
        MISTRAL_ORGANIZATION_KEY,
        MISTRAL_PLATFORM_KEY,
        MISTRAL_ROTATED_KEY,
    ]);
    const server = createServer(async (request, response) => {
        const parts: string[] = [];
        request.setEncoding('utf8');
        for await (const part of request) parts.push(String(part));
        const body = parts.length
            ? (JSON.parse(parts.join('')) as MistralBody)
            : {};
        const path = new URL(request.url ?? '/', 'http://fixture.invalid')
            .pathname;
        state.calls.push({
            path,
            method: request.method,
            body,
            authorization: request.headers.authorization,
        });
        response.setHeader('content-type', 'application/json');
        if (
            !keys.has(
                request.headers.authorization?.replace(/^Bearer /, '') ?? ''
            )
        ) {
            response.writeHead(401);
            response.end(
                JSON.stringify({
                    error: { message: 'private-mistral-provider-body' },
                })
            );
            return;
        }
        if (
            path === `${MISTRAL_PROXY_PREFIX}/models` &&
            request.method === 'GET'
        ) {
            await state.beforeModels?.();
            response.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        {
                            id: 'mistral-embed-2312',
                            aliases: ['mistral-embed'],
                            ['max_context_length']: 8192,
                            capabilities: {},
                        },
                        {
                            id: 'unreviewed-chat-model',
                            aliases: ['mistral-embed'],
                            ['max_context_length']: 128_000,
                            capabilities: { ['completion_chat']: true },
                        },
                    ].filter(
                        (entry) =>
                            !state.unreviewedCatalog ||
                            entry.id === 'unreviewed-chat-model'
                    ),
                })
            );
            return;
        }
        if (
            path !== `${MISTRAL_PROXY_PREFIX}/embeddings` ||
            request.method !== 'POST'
        ) {
            response.writeHead(404);
            response.end('{}');
            return;
        }
        await state.beforeEmbedding?.();
        if (state.rejectEmbeddings) {
            response.writeHead(400);
            response.end(
                JSON.stringify({
                    error: { message: 'private-mistral-provider-body' },
                })
            );
            return;
        }
        const dimensions = state.invalidDimensions ? 3 : 1024;
        response.end(
            JSON.stringify({
                object: 'list',
                model: state.responseModel,
                data: (body.input ?? [])
                    .map((text, index) => ({
                        object: 'embedding',
                        index: state.invalidIndex
                            ? (body.input?.length ?? 0)
                            : state.duplicateIndex
                              ? 0
                              : index,
                        embedding: Array.from(
                            { length: dimensions },
                            (_, component) =>
                                component ===
                                (text.includes('needle-mistral') ? 0 : 1)
                                    ? 1
                                    : 0
                        ),
                    }))
                    .toReversed(),
                usage: {
                    ['prompt_tokens']: (body.input?.length ?? 0) * 7,
                    ['total_tokens']: (body.input?.length ?? 0) * 7,
                },
            })
        );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    return {
        state,
        endpoint: `http://127.0.0.1:${address.port}${MISTRAL_PROXY_PREFIX}`,
        embeddings: () =>
            state.calls.filter((call) => call.path.endsWith('/embeddings')),
        platformCalls: () =>
            state.calls.filter(
                (call) =>
                    call.authorization === `Bearer ${MISTRAL_PLATFORM_KEY}`
            ).length,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** A missing request must fail the fixture instead of leaving the serial catalog suite blocked. */
export async function waitForMistralRequest(promise: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                'The controlled provider request did not arrive.'
                            )
                        ),
                    5000
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
