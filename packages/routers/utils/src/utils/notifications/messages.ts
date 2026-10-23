import { resolveLocale } from '@repo/i18n/locale';

const messages = {
    en: {
        title: 'New sign-in to your account',
        action: 'Open my account',
    },
    fr: {
        title: 'Nouvelle connexion à votre compte',
        action: 'Ouvrir mon compte',
    },
    'nl-BE': {
        title: 'Nieuwe aanmelding op uw account',
        action: 'Mijn account openen',
    },
} as const;

/** Resolve saved recipient preferences consistently for inbox creation and email delivery. */
export function accountSignInMessages(savedLocale: unknown) {
    const locale = resolveLocale({ savedLocale });
    return { locale, ...messages[locale] };
}
