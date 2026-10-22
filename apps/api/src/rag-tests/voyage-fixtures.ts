import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const VOYAGE_ORGANIZATION_KEY = 'voyage-organization-synthetic-key';
export const VOYAGE_PLATFORM_KEY = 'voyage-platform-synthetic-key';
export const VOYAGE_ROTATED_KEY = 'voyage-rotated-synthetic-key';

type VoyageBody = {
    input?: string[];
    model?: string;
    input_type?: string;
    output_dimension?: number;
    output_dtype?: string;
    encoding_format?: string | null;
    truncation?: boolean;
};

/** Controlled native Voyage protocol; reversed response rows test input-index association, not model quality. */
export async function createVoyageHttpFixture() {
    const state: {
        calls: {
            path: string;
            authorization: string | undefined;
            body: VoyageBody;
        }[];
        rejectEmbeddings: boolean;
        invalidDimensions: boolean;
        invalidIndex: boolean;
        beforeEmbedding?: () => Promise<void>;
    } = {
        calls: [],
        rejectEmbeddings: false,
        invalidDimensions: false,
        invalidIndex: false,
    };
    const keys = new Set([
        VOYAGE_ORGANIZATION_KEY,
        VOYAGE_PLATFORM_KEY,
        VOYAGE_ROTATED_KEY,
    ]);
    const server = createServer(async (request, response) => {
        const parts: string[] = [];
        request.setEncoding('utf8');
        for await (const part of request) parts.push(String(part));
        const body = parts.length
            ? (JSON.parse(parts.join('')) as VoyageBody)
            : {};
        const path = new URL(request.url ?? '/', 'http://fixture.invalid')
            .pathname;
        state.calls.push({
            path,
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
                JSON.stringify({ detail: 'private-voyage-provider-body' })
            );
            return;
        }
        if (path !== '/v1/embeddings') {
            response.writeHead(404);
            response.end('{}');
            return;
        }
        await state.beforeEmbedding?.();
        if (state.rejectEmbeddings) {
            response.writeHead(400);
            response.end(
                JSON.stringify({ detail: 'private-voyage-provider-body' })
            );
            return;
        }
        const dimensions = state.invalidDimensions
            ? 3
            : (body.output_dimension ?? 1024);
        response.end(
            JSON.stringify({
                object: 'list',
                model: body.model,
                data: (body.input ?? [])
                    .map((text, index) => ({
                        object: 'embedding',
                        index: state.invalidIndex ? 1 : index,
                        embedding: Array.from(
                            { length: dimensions },
                            (_, component) =>
                                component ===
                                (text.includes('needle-voyage') ? 0 : 1)
                                    ? 1
                                    : 0
                        ),
                    }))
                    .toReversed(),
                usage: { ['total_tokens']: (body.input?.length ?? 0) * 7 },
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
        platformCalls: () =>
            state.calls.filter(
                (call) => call.authorization === `Bearer ${VOYAGE_PLATFORM_KEY}`
            ).length,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** Bound controlled I/O latches so a missing native request cannot hang the catalog suite. */
export async function waitForVoyageRequest(promise: Promise<void>) {
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
