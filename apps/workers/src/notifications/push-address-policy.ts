import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

export const MAX_PUSH_DNS_ANSWERS = 64;

const blockedV4 = new BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const)
    blockedV4.addSubnet(network, prefix, 'ipv4');

const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['2620:4f:8000::', 48],
    ['3fff::', 20],
] as const)
    blockedV6.addSubnet(network, prefix, 'ipv6');

export type PublicPushAddress = Readonly<{
    address: string;
    family: 4 | 6;
}>;

/**
 * Conservative public-unicast policy, reviewed against the IANA special-purpose
 * registries (2025-10-09). All listed special-purpose IPv4 blocks are denied,
 * including globally reachable exceptions; IPv6 permits only 2000::/3 minus
 * special/documentation/transition blocks. Mapped/NAT64/scope IDs fail closed.
 * This classifies an address, not its actual routing or service ownership.
 */
export function isPublicPushAddress(address: string, family: number): boolean {
    if (
        typeof address !== 'string' ||
        address.length > 45 ||
        address.includes('%') ||
        (family !== 4 && family !== 6) ||
        isIP(address) !== family
    )
        return false;
    return family === 4
        ? !blockedV4.check(address, 'ipv4')
        : publicV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

/** Reject the complete resolution if any answer is invalid/private; never filter it to a safe subset. */
export function publicPushAddressAnswers(
    answers: readonly LookupAddress[]
): readonly PublicPushAddress[] | null {
    if (
        !Array.isArray(answers) ||
        answers.length === 0 ||
        answers.length > MAX_PUSH_DNS_ANSWERS
    )
        return null;
    const result: PublicPushAddress[] = [];
    for (const answer of answers) {
        if (
            !answer ||
            (answer.family !== 4 && answer.family !== 6) ||
            !isPublicPushAddress(answer.address, answer.family)
        )
            return null;
        result.push(
            Object.freeze({ address: answer.address, family: answer.family })
        );
    }
    return Object.freeze(result);
}
