import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { indexError } from './errors';
import { SOURCE_RECEIPT_TTL_MS } from './source-retention';

const identity = z.string().min(1).max(128);
const receiptPayload = z
    .object({
        v: z.literal(1),
        organizationId: identity,
        collectionId: identity,
        generationId: identity,
        publicationId: identity,
        chunkId: identity,
        versionId: identity,
        extractionId: identity,
        issuedAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
    })
    .strict()
    .refine(
        (value) => value.expiresAt - value.issuedAt === SOURCE_RECEIPT_TTL_MS
    );
export type SourceReceipt = z.infer<typeof receiptPayload>;

function key() {
    const secret = process.env.ENCRYPTION_SECRET;
    if (!secret || secret.length < 32) throw indexError('CREDENTIALS_INVALID');
    return createHmac('sha256', secret)
        .update('vectorix-index-source-receipt-v1')
        .digest();
}

/** A receipt binds provenance and expiry; it never grants access independently of current authorization. */
export function issueSourceReceipt(
    input: Omit<SourceReceipt, 'v' | 'issuedAt' | 'expiresAt'>
) {
    const issuedAt = Date.now();
    const payload = receiptPayload.parse({
        ...input,
        v: 1,
        issuedAt,
        expiresAt: issuedAt + SOURCE_RECEIPT_TTL_MS,
    });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', key())
        .update(body)
        .digest('base64url');
    return {
        receipt: `${body}.${signature}`,
        expiresAt: new Date(payload.expiresAt),
    };
}

/** Constant-time MAC verification precedes parsing; malformed, expired and cross-collection receipts fail identically. */
export function verifySourceReceipt(
    receipt: string,
    organizationId: string,
    collectionId: string
): SourceReceipt {
    try {
        if (receipt.length > 4096) throw new Error('Invalid source receipt.');
        const [body, mac, extra] = receipt.split('.');
        if (
            !body ||
            !mac ||
            extra ||
            !/^[A-Za-z0-9_-]+$/.test(body) ||
            !/^[A-Za-z0-9_-]{43}$/.test(mac)
        )
            throw new Error('Invalid source receipt.');
        const expected = createHmac('sha256', key()).update(body).digest();
        const actual = Buffer.from(mac, 'base64url');
        if (
            actual.length !== expected.length ||
            !timingSafeEqual(actual, expected)
        )
            throw new Error('Invalid source receipt.');
        const value = receiptPayload.parse(
            JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
        );
        if (
            value.organizationId !== organizationId ||
            value.collectionId !== collectionId ||
            value.expiresAt <= Date.now() ||
            value.issuedAt > Date.now()
        )
            throw new Error('Invalid source receipt.');
        return value;
    } catch {
        throw indexError('SOURCE_UNAVAILABLE');
    }
}
