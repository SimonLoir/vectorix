const DEFAULT_TRUSTED_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:3006',
] as const;

const MAX_URL_CHARACTERS = 8192;

function hasUnsafeUrlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.codePointAt(index) ?? 0;
        if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
    }
    return false;
}

/** Reject WHATWG URL repairs that could turn malformed security headers into trusted URLs. */
function httpUrl(value: string): URL | null {
    if (
        value.length === 0 ||
        value.length > MAX_URL_CHARACTERS ||
        hasUnsafeUrlCharacters(value) ||
        value.includes('#')
    )
        return null;
    const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
    if (!authority || authority.includes('@') || authority.includes('*'))
        return null;
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            !url.username &&
            !url.password
            ? url
            : null;
    } catch {
        return null;
    }
}

/** An Origin header/configuration entry must be one complete serialized HTTP(S) origin. */
export function serializedHttpOrigin(value: string): string | null {
    const url = httpUrl(value);
    return url?.origin === value ? url.origin : null;
}

/** Referer may contain a path/query, but never credentials, controls, fragments or repaired authority. */
export function httpRefererOrigin(value: string): string | null {
    return httpUrl(value)?.origin ?? null;
}

/** Fail startup with a fixed diagnostic rather than echoing a configured URL or falling back. */
export class TrustedOriginsConfigurationError extends Error {
    constructor() {
        super('Invalid TRUSTED_ORIGINS configuration.');
        this.name = 'TrustedOriginsConfigurationError';
    }
}

/**
 * Resolve the sole browser-origin allowlist once on the server. Only an absent
 * variable gets development defaults; explicitly empty/invalid lists refuse.
 * CORS and cookie-CSRF must consume this same validated, deduplicated list.
 */
export function resolveTrustedOrigins(value?: string): string[] {
    if (value === undefined) return [...DEFAULT_TRUSTED_ORIGINS];
    const entries = value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (
        entries.length === 0 ||
        entries.some((entry) => serializedHttpOrigin(entry) === null)
    )
        throw new TrustedOriginsConfigurationError();
    return [...new Set(entries)];
}
