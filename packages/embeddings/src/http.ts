import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';
import {
    EmbeddingError,
    type EmbeddingConfiguration,
    type RequestOptions,
} from './types';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
type NativePath =
    'api/tags' | 'api/show' | 'api/embed' | 'v1/models' | 'v2/embed';

function isCohereConfigurationValid(config: EmbeddingConfiguration, url: URL) {
    return (
        config.provider !== 'COHERE' ||
        (url.pathname === '/' &&
            typeof config.apiKey === 'string' &&
            Boolean(config.apiKey.trim()))
    );
}

/** Every discovery/probe/batch operation shares one deadline, including retries and manifest checks. */
export function operationSignal(options: RequestOptions = {}) {
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    const deadline = AbortSignal.timeout(timeout);
    return options.signal
        ? AbortSignal.any([deadline, options.signal])
        : deadline;
}

/** Exact operator allowlisting belongs to the caller; this boundary rejects credentials/redirect tricks. */
export function configurationUrl(config: EmbeddingConfiguration) {
    try {
        const url = new URL(config.endpoint);
        if (
            !['OLLAMA', 'COHERE'].includes(config.provider) ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            !isCohereConfigurationValid(config, url) ||
            (config.apiKey !== null &&
                (config.apiKey.length > 8192 || /[\r\n]/.test(config.apiKey)))
        )
            throw new Error('Invalid embedding configuration.');
        return `${url.href.replace(/\/$/, '')}/`;
    } catch {
        throw new EmbeddingError('INVALID_CONFIGURATION');
    }
}

/** Only the adapter's fixed native routes may inherit the resolved credentials. */
function nativeUrl(
    config: EmbeddingConfiguration,
    path: NativePath,
    query?: Readonly<Record<string, string>>
) {
    const url = new URL(path, configurationUrl(config));
    const paths =
        config.provider === 'OLLAMA'
            ? ['api/tags', 'api/show', 'api/embed']
            : ['v1/models', 'v2/embed'];
    if (!paths.includes(path))
        throw new EmbeddingError('INVALID_CONFIGURATION');
    if (!query) return url;
    if (path !== 'v1/models' || Object.keys(query).length > 3)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    for (const [key, value] of Object.entries(query)) {
        if (
            !['endpoint', 'page_size', 'page_token'].includes(key) ||
            typeof value !== 'string' ||
            value.length > 512
        )
            throw new EmbeddingError('INVALID_CONFIGURATION');
        url.searchParams.set(key, value);
    }
    return url;
}

function checkJsonDepth(text: string) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (const char of text) {
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else {
            switch (char) {
                case '"':
                    quoted = true;
                    break;
                case '{':
                case '[':
                    depth += 1;
                    if (depth > MAX_JSON_DEPTH)
                        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
                    break;
                case '}':
                case ']':
                    depth -= 1;
                    break;
            }
        }
    }
}
async function boundedJson(response: Response) {
    const size = response.headers.get('content-length');
    if (
        (size !== null &&
            (!/^\d+$/.test(size) || Number(size) > MAX_RESPONSE_BYTES)) ||
        !response.body
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > MAX_RESPONSE_BYTES)
                throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
            chunks.push(next.value);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, total)
        );
        checkJsonDepth(text);
        return JSON.parse(text) as unknown;
    } catch (error) {
        if (error instanceof EmbeddingError) throw error;
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
/** Bounded retry applies only to 429/5xx; redirects and provider text are never surfaced. */
export async function requestJson(
    config: EmbeddingConfiguration,
    path: NativePath,
    signal: AbortSignal,
    body?: unknown,
    query?: Readonly<Record<string, string>>
) {
    const url = nativeUrl(config, path, query);
    if (
        ['api/show', 'api/embed', 'v2/embed'].includes(path) !==
        (body !== undefined)
    )
        throw new EmbeddingError('INVALID_CONFIGURATION');
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded && Buffer.byteLength(encoded) > MAX_REQUEST_BYTES)
        throw new EmbeddingError('INPUT_TOO_LARGE');
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            signal.throwIfAborted();
            const response = await fetch(url, {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(config.apiKey === null
                        ? {}
                        : { Authorization: `Bearer ${config.apiKey}` }),
                },
                body: encoded,
                signal,
                redirect: 'error',
            });
            if (response.ok) return await boundedJson(response);
            await response.body?.cancel().catch(() => {});
            if (response.status === 429 || response.status >= 500) {
                if (attempt === 2)
                    throw new EmbeddingError('PROVIDER_UNAVAILABLE');
                const seconds = response.headers.get('retry-after');
                const wait =
                    seconds && /^\d{1,4}$/.test(seconds)
                        ? Math.min(Number(seconds) * 1000, 2000)
                        : 100 * 2 ** attempt;
                await delay(wait, undefined, { signal });
                continue;
            }
            throw new EmbeddingError('PROVIDER_REJECTED');
        } catch (error) {
            if (signal.aborted) throw new EmbeddingError('PROVIDER_TIMEOUT');
            if (error instanceof EmbeddingError) throw error;
            throw new EmbeddingError('PROVIDER_UNAVAILABLE');
        }
    }
    throw new EmbeddingError('PROVIDER_UNAVAILABLE');
}
