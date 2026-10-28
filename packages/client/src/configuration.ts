import { VectorixClientError } from './errors';

export const VECTORIX_SUPPORTED_API_MAJOR = 1;
export const VECTORIX_MIN_API_REVISION = 24;
export const VECTORIX_DEFAULT_TIMEOUT_MS = 60_000;
export const VECTORIX_MAX_TIMEOUT_MS = 120_000;
export const VECTORIX_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export type VectorixClientOptions = Readonly<{
    /** Absolute HTTP(S) API origin, without a path, query, credentials or fragment. */
    apiUrl: string;
    /** Organization API key. Never place this value in browser-delivered code. */
    apiKey: string;
    /** Pins the key's existing tenant; it never selects or grants another tenant. */
    organizationId?: string;
    /** Trusted transport override; it must honor redirect:error and AbortSignal. */
    fetch?: typeof globalThis.fetch;
    /** Per-call deadline, including encoding, response buffering and decoding. */
    timeoutMs?: number;
}>;

function forbiddenUrlCharacter(value: string) {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= 32 || code === 127 || character === '\\') return true;
    }
    return false;
}

/** Validate local configuration before any HTTP request; no environment or deployment defaults are read. */
export function clientConfiguration(options: VectorixClientOptions) {
    const invalid = () => {
        throw new VectorixClientError('INVALID_CONFIGURATION');
    };
    if (
        typeof options.apiUrl !== 'string' ||
        options.apiUrl.length > 8192 ||
        !/^https?:\/\/[^/?#]+\/?$/iu.test(options.apiUrl) ||
        forbiddenUrlCharacter(options.apiUrl)
    )
        invalid();
    let url: URL;
    try {
        url = new URL(options.apiUrl);
    } catch {
        return invalid();
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    )
        invalid();
    if (
        typeof options.apiKey !== 'string' ||
        options.apiKey.length < 1 ||
        options.apiKey.length > 4096 ||
        /[^\u0021-\u007E]/u.test(options.apiKey)
    )
        invalid();
    if (
        options.organizationId !== undefined &&
        (typeof options.organizationId !== 'string' ||
            options.organizationId.length < 1 ||
            options.organizationId.length > 128 ||
            /[^\u0021-\u007E]/u.test(options.organizationId))
    )
        invalid();
    const timeoutMs = options.timeoutMs ?? VECTORIX_DEFAULT_TIMEOUT_MS;
    if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > VECTORIX_MAX_TIMEOUT_MS
    )
        invalid();
    const fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== 'function') invalid();
    const headers = new Headers({ 'x-api-key': options.apiKey });
    if (options.organizationId !== undefined)
        headers.set(
            'Vectorix-Expected-Organization-Id',
            options.organizationId
        );
    return { origin: url.origin, headers, timeoutMs, fetcher };
}
export type ClientConfiguration = ReturnType<typeof clientConfiguration>;
