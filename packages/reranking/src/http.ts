import { Buffer } from 'node:buffer';
import { RERANKING_LIMITS } from './models';
import {
    RerankingError,
    type RerankingConfiguration,
    type RerankingOptions,
} from './types';

/** Operator destination allowlisting belongs to the caller, as for hosted embeddings. */
export function configurationUrl(configuration: RerankingConfiguration): URL {
    try {
        const url = new URL(configuration.endpoint);
        if (
            (configuration.provider !== 'COHERE' &&
                configuration.provider !== 'VOYAGE') ||
            (url.protocol !== 'http:' && url.protocol !== 'https:') ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== '/' ||
            typeof configuration.apiKey !== 'string' ||
            !configuration.apiKey.trim() ||
            configuration.apiKey.length > 8192 ||
            [...configuration.apiKey].some(
                (character) => character < ' ' || character === '\u007F'
            )
        )
            throw new RerankingError('INVALID_CONFIGURATION');
        return new URL(
            configuration.provider === 'COHERE' ? 'v2/rerank' : 'v1/rerank',
            url
        );
    } catch {
        throw new RerankingError('INVALID_CONFIGURATION');
    }
}

/** The same abort signal covers headers and every streamed body read, with no retries. */
export function operationSignal(options: RerankingOptions): AbortSignal {
    const timeoutMs = options.timeoutMs ?? RERANKING_LIMITS.timeoutMs;
    if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > RERANKING_LIMITS.timeoutMs
    )
        throw new RerankingError('INVALID_CONFIGURATION');
    const timeout = AbortSignal.timeout(timeoutMs);
    return options.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout;
}

function checkJsonDepth(text: string) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const character of text) {
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
            continue;
        }
        switch (character) {
            case '"':
                quoted = true;
                break;
            case '{':
            case '[':
                if (++depth > 16)
                    throw new RerankingError('INVALID_PROVIDER_RESPONSE');
                break;
            case '}':
            case ']':
                depth--;
                break;
        }
    }
}

async function boundedJson(response: Response): Promise<unknown> {
    const length = response.headers.get('content-length');
    if (
        (length !== null &&
            (!/^\d+$/.test(length) ||
                Number(length) > RERANKING_LIMITS.responseBytes)) ||
        !response.body
    ) {
        await response.body?.cancel().catch(() => {});
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > RERANKING_LIMITS.responseBytes)
                throw new RerankingError('INVALID_PROVIDER_RESPONSE');
            chunks.push(next.value);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, bytes)
        );
        checkJsonDepth(text);
        return JSON.parse(text) as unknown;
    } catch (error) {
        if (error instanceof RerankingError) throw error;
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Dispatches exactly one POST; redirects, HTTP errors and response bodies never escape. */
export async function requestJson(
    url: URL,
    apiKey: string,
    encoded: string,
    signal: AbortSignal
): Promise<unknown> {
    if (Buffer.byteLength(encoded, 'utf8') > RERANKING_LIMITS.requestBytes)
        throw new RerankingError('INPUT_TOO_LARGE');
    try {
        signal.throwIfAborted();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: encoded,
            signal,
            redirect: 'manual',
        });
        if (response.status !== 200) {
            await response.body?.cancel().catch(() => {});
            throw new RerankingError(
                response.status === 429 || response.status >= 500
                    ? 'PROVIDER_UNAVAILABLE'
                    : 'PROVIDER_REJECTED'
            );
        }
        return await boundedJson(response);
    } catch (error) {
        if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
        if (error instanceof RerankingError) throw error;
        throw new RerankingError('PROVIDER_UNAVAILABLE');
    }
}
