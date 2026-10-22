import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const COHERE_ORGANIZATION_KEY = 'cohere-organization-synthetic-key';
export const COHERE_PLATFORM_KEY = 'cohere-platform-synthetic-key';
export const COHERE_ROTATED_KEY = 'cohere-rotated-synthetic-key';

type EmbedBody = {
    model?: string;
    texts?: string[];
    input_type?: string;
    output_dimension?: number;
    embedding_types?: string[];
    truncate?: string;
};
export type CohereCall = {
    path: string;
    authorization: string | undefined;
    body: EmbedBody;
};

/** Native Cohere protocol with synthetic vectors; this fixture never contacts a hosted model or reads paid credentials. */
export async function createCohereHttpFixture() {
    const state: {
        calls: CohereCall[];
        rejectEmbeddings: boolean;
        invalidDimensions: boolean;
        beforeEmbedding?: () => Promise<void>;
        beforeModels?: () => Promise<void>;
    } = { calls: [], rejectEmbeddings: false, invalidDimensions: false };
    const validKeys = new Set([
        COHERE_ORGANIZATION_KEY,
        COHERE_PLATFORM_KEY,
        COHERE_ROTATED_KEY,
    ]);
    const server = createServer(async (request, response) => {
        const parts: string[] = [];
        request.setEncoding('utf8');
        for await (const part of request) parts.push(String(part));
        const body = parts.length
            ? (JSON.parse(parts.join('')) as EmbedBody)
            : {};
        const url = new URL(request.url ?? '/', 'http://fixture.invalid');
        state.calls.push({
            path: url.pathname,
            authorization: request.headers.authorization,
            body,
        });
        response.setHeader('content-type', 'application/json');
        if (
            !validKeys.has(
                request.headers.authorization?.replace(/^Bearer /, '') ?? ''
            )
        ) {
            response.writeHead(401);
            response.end(
                JSON.stringify({ message: 'private-cohere-error-body' })
            );
            return;
        }
        if (url.pathname === '/v1/models') {
            await state.beforeModels?.();
            response.end(
                JSON.stringify({
                    models: [
                        {
                            name: 'embed-v4.0',
                            endpoints: ['embed'],
                            ['is_deprecated']: false,
                            ['context_length']: 128_000,
                        },
                        {
                            name: 'embed-multilingual-v3.0',
                            endpoints: ['embed'],
                            ['is_deprecated']: false,
                            ['context_length']: 512,
                        },
                        {
                            name: 'unapproved-new-embedding-model',
                            endpoints: ['embed'],
                            ['context_length']: 128_000,
                        },
                        { name: 'chat-model', endpoints: ['chat'] },
                    ],
                })
            );
            return;
        }
        if (url.pathname !== '/v2/embed') {
            response.writeHead(404);
            response.end('{}');
            return;
        }
        await state.beforeEmbedding?.();
        if (state.rejectEmbeddings) {
            response.writeHead(400);
            response.end(
                JSON.stringify({ message: 'private-cohere-error-body' })
            );
            return;
        }
        const dimensions = state.invalidDimensions
            ? 3
            : (body.output_dimension ?? 1024);
        response.end(
            JSON.stringify({
                id: 'synthetic-cohere-response',
                texts: body.texts,
                embeddings: {
                    float: (body.texts ?? []).map((text) =>
                        Array.from({ length: dimensions }, (_, index) =>
                            index === 0
                                ? 1 + (text.match(/fox|renard/gi)?.length ?? 0)
                                : index === 1
                                  ? 1 +
                                    (text.match(/solar|solaire/gi)?.length ?? 0)
                                  : 1 / (index + 1)
                        )
                    ),
                },
                meta: {
                    ['api_version']: { version: '2' },
                    tokens: { ['input_tokens']: (body.texts?.length ?? 0) * 5 },
                    ['billed_units']: {
                        ['input_tokens']: (body.texts?.length ?? 0) * 5,
                    },
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
        endpoint: `http://127.0.0.1:${address.port}`,
        embeddings: () =>
            state.calls.filter((call) => call.path === '/v2/embed'),
        platformCalls: () =>
            state.calls.filter(
                (call) => call.authorization === `Bearer ${COHERE_PLATFORM_KEY}`
            ).length,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** A bounded latch turns missing provider I/O into a test failure rather than hanging the suite. */
export async function waitForCohereRequest(promise: Promise<void>) {
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
