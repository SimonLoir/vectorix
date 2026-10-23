import { createEmailVerificationToken } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import { UserModelSchema } from '@repo/db/schemas';
import { emailOwnershipReturnTo } from './configuration';
import { emailOwnershipError } from './errors';

const emailSchema = UserModelSchema.shape.email.email().max(320);
const idSchema = UserModelSchema.shape.id.min(1).max(128);
export type EmailProofPhase =
    'change-email-confirmation' | 'change-email-verification';
type NativeClaims = {
    email: string;
    updateTo?: string;
    requestType?: EmailProofPhase;
    exp: number;
};
export type EmailOwnershipClaims = NativeClaims & {
    userId: string;
    vectorixEmailOwnership: 1;
    returnTo: string;
};

function nativeClaims(value: unknown): NativeClaims {
    if (
        !value ||
        typeof value !== 'object' ||
        !('email' in value) ||
        !('exp' in value)
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    }
    const email = emailSchema.safeParse(value.email);
    if (
        !email.success ||
        typeof value.exp !== 'number' ||
        !Number.isSafeInteger(value.exp) ||
        value.exp <= Math.floor(Date.now() / 1000)
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    }
    if (!('updateTo' in value) || value.updateTo === undefined) {
        if ('requestType' in value && value.requestType !== undefined)
            throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
        return { email: email.data, exp: value.exp };
    }
    const updateTo = emailSchema.safeParse(value.updateTo);
    if (
        !updateTo.success ||
        !('requestType' in value) ||
        (value.requestType !== 'change-email-confirmation' &&
            value.requestType !== 'change-email-verification')
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    }
    return {
        email: email.data,
        exp: value.exp,
        updateTo: updateTo.data,
        requestType: value.requestType,
    };
}

async function verifiedPayload(
    token: unknown,
    secret: string
): Promise<unknown> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 8192) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    }
    return await verifyJWT<unknown>(token, secret);
}

/** Re-sign only verified native claims, adding the immutable account binding to each mail stage. */
export async function bindEmailOwnershipToken(input: {
    token: string;
    userId: string;
    secret: string;
    returnTo: string;
}): Promise<{ token: string; claims: EmailOwnershipClaims }> {
    const claims = nativeClaims(
        await verifiedPayload(input.token, input.secret)
    );
    const userId = idSchema.safeParse(input.userId);
    if (!userId.success)
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    const returnTo = emailOwnershipReturnTo(input.returnTo);
    const remaining = claims.exp - Math.ceil(Date.now() / 1000) - 1;
    if (remaining <= 0)
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    const token = await createEmailVerificationToken(
        input.secret,
        claims.email,
        claims.updateTo,
        remaining,
        {
            ...(claims.requestType ? { requestType: claims.requestType } : {}),
            userId: userId.data,
            vectorixEmailOwnership: 1,
            returnTo,
        }
    );
    return {
        token,
        claims: {
            ...claims,
            userId: userId.data,
            vectorixEmailOwnership: 1,
            returnTo,
        },
    };
}

/** Unbound legacy/native tokens cannot reach the replacement mutation service. */
export async function readEmailOwnershipToken(
    token: unknown,
    secret: string
): Promise<EmailOwnershipClaims> {
    const payload = await verifiedPayload(token, secret);
    const claims = nativeClaims(payload);
    if (
        !payload ||
        typeof payload !== 'object' ||
        !('userId' in payload) ||
        !('vectorixEmailOwnership' in payload) ||
        payload.vectorixEmailOwnership !== 1 ||
        !('returnTo' in payload)
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    }
    const userId = idSchema.safeParse(payload.userId);
    if (!userId.success || typeof payload.returnTo !== 'string')
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    return {
        ...claims,
        userId: userId.data,
        vectorixEmailOwnership: 1,
        returnTo: emailOwnershipReturnTo(payload.returnTo),
    };
}
