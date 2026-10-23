import { isIP } from 'node:net';

const MAX_CONFIGURATION_LENGTH = 8192;
const MAX_OPERATOR_ORIGINS = 32;
const MAX_ENDPOINT_LENGTH = 2048;
const NATIVE_NAMESPACES = [
    'push.services.mozilla.com',
    'notify.windows.com',
    'push.apple.com',
] as const;

export type PushEndpointPolicy = Readonly<{
    source: 'NATIVE' | 'OPERATOR';
    origins: readonly string[];
}>;

export type AdmittedPushEndpoint = Readonly<{
    /** Original opaque subscription identity; never replace it with URL.href. */
    endpoint: string;
    hostname: string;
    origin: string;
    /** Original path and query, including dot segments and percent encoding. */
    requestPath: string;
}>;

/** A configuration failure contains no operator input or nested parsing error. */
export class PushEndpointPolicyConfigurationError extends Error {
    constructor() {
        super('Web Push endpoint policy is unavailable.');
        this.name = 'PushEndpointPolicyConfigurationError';
    }
}

function hasAmbiguousCharacters(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (
            character === '\\' ||
            character.trim() === '' ||
            code <= 0x20 ||
            (code >= 0x7f && code <= 0x9f) ||
            (code >= 0xd8_00 && code <= 0xdf_ff)
        )
            return true;
    }
    return false;
}

function isDnsHostname(hostname: string): boolean {
    return (
        hostname.length > 0 &&
        hostname.length <= 253 &&
        isIP(hostname) === 0 &&
        hostname
            .split('.')
            .every((label) =>
                /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
            )
    );
}

/**
 * Inspect only the destination authority. Restrict it to unambiguous ASCII DNS
 * so WHATWG validation, native VAPID generation and HTTPS agree on the host.
 * The opaque path/query are extracted from the original input, never URL-normalized.
 */
function inspectEndpoint(value: unknown): AdmittedPushEndpoint | null {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_ENDPOINT_LENGTH ||
        value.includes('#') ||
        hasAmbiguousCharacters(value)
    )
        return null;
    const match = /^https:\/\/([^/?#]+)(.*)$/u.exec(value);
    if (!match) return null;
    const authority = match[1]!;
    const colon = authority.indexOf(':');
    const rawHostname = colon === -1 ? authority : authority.slice(0, colon);
    if (colon !== -1 && authority.slice(colon + 1) !== '443') return null;
    if (!/^[a-zA-Z0-9.-]+$/u.test(rawHostname)) return null;
    const hostname = rawHostname.toLowerCase();
    if (!isDnsHostname(hostname)) return null;
    try {
        const parsed = new URL(value);
        if (
            parsed.protocol !== 'https:' ||
            parsed.username !== '' ||
            parsed.password !== '' ||
            parsed.hostname !== hostname ||
            parsed.port !== ''
        )
            return null;
        const remainder = match[2]!;
        return {
            endpoint: value,
            hostname,
            origin: parsed.origin,
            requestPath: remainder.startsWith('/')
                ? remainder
                : `/${remainder}`,
        };
    } catch {
        return null;
    }
}

/**
 * Build a server-controlled policy without reading environment or making I/O.
 * Absence selects known native DNS namespaces, not universal browser coverage.
 * A supplied comma-separated exact-origin list replaces all native defaults.
 * Invalid configuration never falls back and must not trigger mass revocation.
 */
export function createPushEndpointPolicy(
    configuration?: string
): PushEndpointPolicy {
    if (configuration === undefined)
        return Object.freeze({
            source: 'NATIVE',
            origins: Object.freeze([]),
        });
    if (configuration.length > MAX_CONFIGURATION_LENGTH)
        throw new PushEndpointPolicyConfigurationError();
    const origins = new Set<string>();
    for (const entry of configuration.split(',')) {
        const trimmed = entry.trim();
        if (trimmed === '') continue;
        const inspected = inspectEndpoint(trimmed);
        if (!inspected || inspected.requestPath !== '/')
            throw new PushEndpointPolicyConfigurationError();
        origins.add(inspected.origin);
        if (origins.size > MAX_OPERATOR_ORIGINS)
            throw new PushEndpointPolicyConfigurationError();
    }
    if (origins.size === 0) throw new PushEndpointPolicyConfigurationError();
    return Object.freeze({
        source: 'OPERATOR',
        origins: Object.freeze([...origins]),
    });
}

/**
 * Admit an opaque endpoint before persistence and again before every dispatch.
 * Only trusted operator origins or the bounded native DNS namespaces grant access;
 * this pure check does not attest to DNS answers or transport behavior.
 */
export function admitPushEndpoint(
    endpoint: unknown,
    policy: PushEndpointPolicy
): AdmittedPushEndpoint | null {
    const inspected = inspectEndpoint(endpoint);
    if (!inspected) return null;
    const allowed =
        policy.source === 'OPERATOR'
            ? policy.origins.includes(inspected.origin)
            : policy.source === 'NATIVE' &&
              (inspected.hostname === 'fcm.googleapis.com' ||
                  NATIVE_NAMESPACES.some(
                      (namespace) =>
                          inspected.hostname === namespace ||
                          inspected.hostname.endsWith(`.${namespace}`)
                  ));
    return allowed ? Object.freeze(inspected) : null;
}
