import {
    assertEmailOwnershipConfigured,
    emailOwnershipReturnTo,
    emailOwnershipSecret,
} from './configuration';
import { bindEmailOwnershipToken } from './tokens';
import { sendEmailOwnershipMessage } from './messages';
import { emailOwnershipError } from './errors';

/** Replaces the framework's request-derived URL with a canonical web destination and immutable signed identity. */
export async function sendEmailOwnershipVerification(
    input: {
        user: { id: string; email: string; locale?: unknown };
        token: string;
        url: string;
    },
    request?: Request
): Promise<void> {
    assertEmailOwnershipConfigured();
    let returnTo: string;
    try {
        const nativeUrl = new URL(input.url);
        returnTo = emailOwnershipReturnTo(
            nativeUrl.searchParams.get('callbackURL') ?? undefined
        );
    } catch {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_CALLBACK');
    }
    const proof = await bindEmailOwnershipToken({
        token: input.token,
        userId: input.user.id,
        secret: emailOwnershipSecret(),
        returnTo,
    });
    const recipient =
        proof.claims.requestType === 'change-email-confirmation'
            ? proof.claims.email
            : (proof.claims.updateTo ?? proof.claims.email);
    if (recipient !== input.user.email.toLowerCase())
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
    await sendEmailOwnershipMessage({
        ...proof,
        savedLocale: input.user.locale,
        request,
    });
}
