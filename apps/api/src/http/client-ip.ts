import { BlockList, isIP } from 'node:net';
import { VECTORIX_CLIENT_IP_HEADER } from '@repo/auth/rate-limit';

/** Normalize an IPv4-mapped IPv6 socket address to plain IPv4. */
function normalize(address: string): string {
    const lower = address.trim().toLowerCase();
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(lower);
    return mapped ? mapped[1]! : lower;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
    const version = isIP(address);
    if (version === 4) return 'ipv4';
    return version === 6 ? 'ipv6' : null;
}

/**
 * Parse `VECTORIX_TRUSTED_PROXIES`: comma-separated IP addresses or CIDR
 * ranges of the reverse proxies directly in front of the API. Invalid entries
 * fail startup with their 1-based position, never their value.
 */
export function parseTrustedProxies(value: string | undefined): BlockList {
    const trusted = new BlockList();
    for (const [index, raw] of (value ?? '').split(',').entries()) {
        const entry = raw.trim();
        if (!entry) continue;
        const [address = '', prefix, extra] = entry.split('/');
        const type = family(normalize(address));
        const bits = prefix === undefined ? undefined : Number(prefix);
        const max = type === 'ipv4' ? 32 : 128;
        if (
            !type ||
            extra !== undefined ||
            (prefix !== undefined && (!/^\d+$/u.test(prefix) || bits! > max))
        )
            throw new Error(
                `VECTORIX_TRUSTED_PROXIES entry ${index + 1} is not an IP address or CIDR range.`
            );
        if (bits === undefined) trusted.addAddress(normalize(address), type);
        else trusted.addSubnet(normalize(address), bits, type);
    }
    return trusted;
}

function isTrusted(address: string, trusted: BlockList): boolean {
    const type = family(address);
    return type !== null && trusted.check(address, type);
}

/**
 * Resolve the client address for rate limiting and session records. The
 * socket peer is authoritative. `X-Forwarded-For` is read only when that peer
 * is a trusted proxy, walking hops right to left past further trusted proxies
 * to the first untrusted address. A malformed hop, or a chain made only of
 * trusted proxies, yields null instead of a spoofable value.
 */
export function resolveClientIp(
    peer: string | undefined,
    forwardedFor: string | null,
    trusted: BlockList
): string | null {
    const peerAddress = peer ? normalize(peer) : '';
    if (!family(peerAddress)) return null;
    if (!isTrusted(peerAddress, trusted)) return peerAddress;
    const hops = (forwardedFor ?? '')
        .split(',')
        .map((hop) => normalize(hop))
        .filter(Boolean);
    for (let index = hops.length - 1; index >= 0; index--) {
        const hop = hops[index]!;
        if (!family(hop)) return null;
        if (!isTrusted(hop, trusted)) return hop;
    }
    return null;
}

/**
 * Copy an auth request with the derived client address in the internal header,
 * replacing or removing any value the client sent.
 */
export function withClientIp(request: Request, clientIp: string | null) {
    const headers = new Headers(request.headers);
    headers.delete(VECTORIX_CLIENT_IP_HEADER);
    if (clientIp) headers.set(VECTORIX_CLIENT_IP_HEADER, clientIp);
    return new Request(request, { headers });
}
