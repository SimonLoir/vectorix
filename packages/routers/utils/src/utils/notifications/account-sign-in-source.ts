import type { Prisma, PrismaClient } from '@repo/db';
import { compositeSourceId, parseCompositeSourceId } from './composite-source';
import { compactSubject } from './compact-text';

type Db = PrismaClient | Prisma.TransactionClient;

/** ACCOUNT_SIGN_IN: one notice per member and Better Auth session. */
export function accountSignInSourceId(memberId: string, sessionId: string) {
    return compositeSourceId([memberId, sessionId]);
}

export function parseAccountSignInSourceId(value: string) {
    const parts = parseCompositeSourceId(value, 2);
    if (!parts) return null;
    const [memberId, sessionId] = parts as [string, string];
    return { memberId, sessionId };
}

/**
 * A sign-in notice stays valid while its member still belongs to the tenant.
 * It deliberately does not depend on the session row: a session that was
 * signed out or revoked right away must still be reported to its owner.
 */
export async function accountSignInSourceExists(
    db: Db,
    organizationId: string,
    sourceId: string,
    recipientMemberId?: string
) {
    const identity = parseAccountSignInSourceId(sourceId);
    if (!identity) return false;
    if (recipientMemberId && recipientMemberId !== identity.memberId)
        return false;
    return Boolean(
        await db.member.findFirst({
            where: { id: identity.memberId, organizationId },
            select: { id: true },
        })
    );
}

const BROWSERS: readonly [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\//, 'Edge'],
    [/OPR\/|Opera/, 'Opera'],
    [/SamsungBrowser\//, 'Samsung Internet'],
    [/Firefox\/|FxiOS\//, 'Firefox'],
    [/Chrome\/|CriOS\//, 'Chrome'],
    [/Safari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
    [/iPhone|iPad|iPod/, 'iOS'],
    [/Android/, 'Android'],
    [/Windows/, 'Windows'],
    [/Mac OS X|Macintosh/, 'macOS'],
    [/CrOS/, 'ChromeOS'],
    [/Linux/, 'Linux'],
];

/**
 * Short, non-identifying device label ("Firefox · Linux") from a user agent.
 * Unknown agents (CLI, scripts) keep a bounded raw excerpt.
 */
export function describeSignInDevice(userAgent: string | null | undefined) {
    if (!userAgent?.trim()) return null;
    const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
    const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
    const label = [browser, system].filter(Boolean).join(' · ');
    return compactSubject(label || userAgent.slice(0, 80));
}

/** Frozen sign-in details carried by the outbox payload. */
export type AccountSignInTemplateData = Readonly<{
    device: string | null;
    ipAddress: string | null;
    signedInAt: string;
}>;

export function readAccountSignInTemplateData(
    value: unknown
): AccountSignInTemplateData | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const data = value as Record<string, unknown>;
    if (typeof data.signedInAt !== 'string') return null;
    return {
        device: typeof data.device === 'string' ? data.device : null,
        ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : null,
        signedInAt: data.signedInAt,
    };
}
