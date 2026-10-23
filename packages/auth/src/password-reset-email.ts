import { sendSystemMail } from '@repo/emails';
import { buildCanonicalPasswordResetUrl } from './password-reset-url';

type PasswordResetLocale = 'en' | 'fr' | 'nl-BE';

type PasswordResetEmailInput = Readonly<{
    user: {
        email: string;
        name?: string | null;
    };
    token: string;
    request?: Request;
}>;

const passwordResetTranslations: Record<
    PasswordResetLocale,
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

function parseCookieValue(cookieHeader: string | null, name: string) {
    if (!cookieHeader) return null;

    const cookie = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));

    if (!cookie) return null;

    return decodeURIComponent(cookie.slice(name.length + 1));
}

function normalizeLocale(
    value: string | null | undefined
): PasswordResetLocale | null {
    if (!value) return null;

    const normalized = value.toLowerCase();
    if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr';
    if (normalized === 'nl' || normalized.startsWith('nl-')) return 'nl-BE';
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en';

    return null;
}

function resolveAcceptLanguageLocale(
    acceptLanguage: string | null
): PasswordResetLocale | null {
    if (!acceptLanguage) return null;

    return (
        acceptLanguage
            .split(',')
            .map((part, index) => {
                const [rawTagValue, ...rawParams] = part.trim().split(';');
                const rawTag = rawTagValue?.trim();
                if (!rawTag) return null;

                const locale = normalizeLocale(rawTag);
                if (!locale) return null;

                const qParam = rawParams
                    .map((param) => param.trim())
                    .find((param) => param.startsWith('q='));
                const q = qParam ? Number(qParam.slice(2)) : 1;
                if (!Number.isFinite(q) || q <= 0) return null;

                return { locale, q, index };
            })
            .filter(
                (
                    entry
                ): entry is {
                    locale: PasswordResetLocale;
                    q: number;
                    index: number;
                } => entry !== null
            )
            .toSorted((a, b) => b.q - a.q || a.index - b.index)[0]?.locale ??
        null
    );
}

function resolveLocale(request?: Request): PasswordResetLocale {
    const cookieLocale = normalizeLocale(
        parseCookieValue(request?.headers.get('cookie') ?? null, 'locale')
    );
    if (cookieLocale) return cookieLocale;

    return (
        resolveAcceptLanguageLocale(
            request?.headers.get('accept-language') ?? null
        ) ?? 'fr'
    );
}

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
    locale: PasswordResetLocale;
}) {
    const t = passwordResetTranslations[locale];
    const escapedResetUrl = escapeHtml(resetUrl);

    return `
        <div style="font-family: Arial, sans-serif; color: #111827; line-height: 1.5;">
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
    const locale = resolveLocale(request);
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
