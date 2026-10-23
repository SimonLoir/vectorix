import { sendSystemMail } from '@repo/emails';
import {
    resolveLocale,
    resolveLocaleCookie,
    type Locale,
} from '@repo/i18n/locale';
import { buildCanonicalPasswordResetUrl } from './password-reset-url';

type PasswordResetEmailInput = Readonly<{
    user: {
        email: string;
        name?: string | null;
        locale?: unknown;
    };
    token: string;
    request?: Request;
}>;

const passwordResetTranslations: Record<
    Locale,
    {
        subject: string;
        greeting: (name: string) => string;
        intro: string;
        cta: string;
        expiry: string;
        ignore: string;
    }
> = {
    en: {
        subject: 'Reset your Vectorix password',
        greeting: (name) => `Hello ${name},`,
        intro: 'We received a request to reset your Vectorix password.',
        cta: 'Reset password',
        expiry: 'This link expires in 1 hour.',
        ignore: "If you didn't request this, you can ignore this email.",
    },
    fr: {
        subject: 'Réinitialisation de votre mot de passe Vectorix',
        greeting: (name) => `Bonjour ${name},`,
        intro: 'Nous avons reçu une demande de réinitialisation de votre mot de passe Vectorix.',
        cta: 'Réinitialiser le mot de passe',
        expiry: 'Ce lien expire dans 1 heure.',
        ignore: "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email.",
    },
    'nl-BE': {
        subject: 'Stel uw Vectorix-wachtwoord opnieuw in',
        greeting: (name) => `Hallo ${name},`,
        intro: 'We hebben een aanvraag ontvangen om uw Vectorix-wachtwoord opnieuw in te stellen.',
        cta: 'Wachtwoord opnieuw instellen',
        expiry: 'Deze link vervalt binnen 1 uur.',
        ignore: 'Als u dit niet heeft aangevraagd, kunt u deze e-mail negeren.',
    },
};

function escapeHtml(value: string) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function buildPasswordResetHtml({
    name,
    resetUrl,
    locale,
}: {
    name: string;
    resetUrl: string;
    locale: Locale;
}) {
    const t = passwordResetTranslations[locale];
    const escapedResetUrl = escapeHtml(resetUrl);

    return `
        <div lang="${locale}" style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
            <p>${escapeHtml(t.greeting(name))}</p>
            <p>${escapeHtml(t.intro)}</p>
            <p>
                <a href="${escapedResetUrl}" style="display: inline-block; padding: 10px 16px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px;">
                    ${escapeHtml(t.cta)}
                </a>
            </p>
            <p>${escapeHtml(t.expiry)}</p>
            <p>${escapeHtml(t.ignore)}</p>
        </div>
    `;
}

/** Revalidate the server URL before mail work; request headers affect locale only. */
export async function sendPasswordResetEmail({
    user,
    token,
    request,
}: PasswordResetEmailInput) {
    const resetUrl = buildCanonicalPasswordResetUrl(token);
    const locale = resolveLocale({
        cookieLocale: resolveLocaleCookie(request?.headers.get('cookie')),
        savedLocale: user.locale,
        acceptLanguage: request?.headers.get('accept-language'),
    });
    const t = passwordResetTranslations[locale];
    const trimmedName = user.name?.trim();
    await sendSystemMail(
        user.email,
        t.subject,
        buildPasswordResetHtml({
            name:
                trimmedName && trimmedName.length > 0
                    ? trimmedName
                    : user.email,
            resetUrl,
            locale,
        })
    );
}
