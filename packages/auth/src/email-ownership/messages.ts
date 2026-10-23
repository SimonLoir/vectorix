import { escapeHtml, sendSystemMail } from '@repo/emails';
import { emailOwnershipWebUrl } from './configuration';
import { emailOwnershipError } from './errors';
import type { EmailOwnershipClaims } from './tokens';

type Locale = 'en' | 'fr' | 'nl-BE';
const messages = {
    en: {
        verifySubject: 'Verify your Vectorix email address',
        confirmSubject: 'Confirm your Vectorix email change',
        verify: 'Verify this address to continue using it with your Vectorix account.',
        confirm:
            'Confirm the requested email change. You must then verify the new address before your account changes.',
        action: 'Continue verification',
        session:
            'Sign in to the account that requested this verification. This link does not sign you in.',
        expiry: 'This link expires within one hour. If you did not request it, you can ignore this message.',
    },
    fr: {
        verifySubject: 'Vérifiez votre adresse e-mail Vectorix',
        confirmSubject: 'Confirmez votre changement d’adresse e-mail Vectorix',
        verify: 'Vérifiez cette adresse pour continuer à l’utiliser avec votre compte Vectorix.',
        confirm:
            'Confirmez le changement demandé. Vous devrez ensuite vérifier la nouvelle adresse avant la modification du compte.',
        action: 'Continuer la vérification',
        session:
            'Connectez-vous au compte qui a demandé cette vérification. Ce lien ne vous connecte pas.',
        expiry: 'Ce lien expire dans une heure au maximum. Si vous n’avez pas fait cette demande, ignorez ce message.',
    },
    'nl-BE': {
        verifySubject: 'Verifieer uw Vectorix-e-mailadres',
        confirmSubject: 'Bevestig uw Vectorix-e-mailwijziging',
        verify: 'Verifieer dit adres om het met uw Vectorix-account te gebruiken.',
        confirm:
            'Bevestig de aangevraagde e-mailwijziging. Daarna moet u het nieuwe adres verifiëren voordat uw account wijzigt.',
        action: 'Verificatie voortzetten',
        session:
            'Meld u aan bij het account dat deze verificatie heeft aangevraagd. Deze link meldt u niet aan.',
        expiry: 'Deze link vervalt binnen één uur. Als u dit niet hebt aangevraagd, kunt u dit bericht negeren.',
    },
} as const;

function locale(request?: Request, savedLocale?: unknown): Locale {
    const candidates: string[] = [];
    const cookie = request?.headers
        .get('cookie')
        ?.split(';')
        .find((value) => value.trim().startsWith('locale='));
    if (cookie) {
        try {
            candidates.push(
                decodeURIComponent(cookie.trim().slice('locale='.length))
            );
        } catch {
            /* A malformed language cookie never controls the message or its destination. */
        }
    }
    if (typeof savedLocale === 'string') candidates.push(savedLocale);
    candidates.push(
        ...(request?.headers
            .get('accept-language')
            ?.slice(0, 4096)
            .split(',')
            .map((value) => value.split(';')[0]?.trim() ?? '') ?? [])
    );
    for (const candidate of candidates) {
        const language = candidate.toLowerCase();
        if (language === 'en' || language.startsWith('en-')) return 'en';
        if (language === 'fr' || language.startsWith('fr-')) return 'fr';
        if (language === 'nl' || language.startsWith('nl-')) return 'nl-BE';
    }
    return 'fr';
}

/** Deliver one bound proof outside the application transaction; failures remain safe if the auth framework logs them. */
export async function sendEmailOwnershipMessage(input: {
    token: string;
    claims: EmailOwnershipClaims;
    savedLocale?: unknown;
    request?: Request;
}): Promise<void> {
    const t = messages[locale(input.request, input.savedLocale)];
    const confirming = input.claims.requestType === 'change-email-confirmation';
    const destination = confirming
        ? input.claims.email
        : (input.claims.updateTo ?? input.claims.email);
    const url = emailOwnershipWebUrl(input.token, input.claims.returnTo);
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.5"><p>${escapeHtml(confirming ? t.confirm : t.verify)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(t.action)}</a></p><p>${escapeHtml(t.session)}</p><p>${escapeHtml(t.expiry)}</p></div>`;
    try {
        await sendSystemMail(
            destination,
            confirming ? t.confirmSubject : t.verifySubject,
            html
        );
    } catch {
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
}
