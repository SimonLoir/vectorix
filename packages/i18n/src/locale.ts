export const supportedLocales = ['en', 'fr', 'nl-BE'] as const;
export type Locale = (typeof supportedLocales)[number];
export const defaultLocale: Locale = 'en';

const MAX_LOCALE_LENGTH = 128;
const MAX_ACCEPT_LANGUAGE_LENGTH = 4096;
const MAX_LANGUAGE_PREFERENCES = 128;
const MAX_COOKIE_HEADER_LENGTH = 8192;

/** Normalize a bounded language preference; regional English, French and Dutch use the shared dictionaries. */
export function normalizeLocale(value: unknown): Locale | null {
    if (typeof value !== 'string' || value.length > MAX_LOCALE_LENGTH) {
        return null;
    }
    const language = value.trim().toLowerCase();
    if (!/^(?:en|fr|nl)(?:-[a-z0-9]{1,8})*$/.test(language)) return null;
    if (language === 'fr' || language.startsWith('fr-')) return 'fr';
    return language === 'nl' || language.startsWith('nl-') ? 'nl-BE' : 'en';
}

function preferenceWeight(parameters: string[]): number | null {
    if (parameters.length === 0) return 1;
    if (parameters.length !== 1) return null;
    const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(
        parameters[0]?.trim() ?? ''
    );
    return match ? Number(match[1]) : null;
}

/**
 * Select the highest positive browser preference, preserving header order for ties.
 * Invalid weights, wildcards and unsupported languages are ignored. Oversized headers
 * (over 4 KiB or 128 entries) are ignored in full rather than partially interpreted.
 */
export function resolveAcceptLanguageLocale(value: unknown): Locale | null {
    if (
        typeof value !== 'string' ||
        value.length > MAX_ACCEPT_LANGUAGE_LENGTH
    ) {
        return null;
    }
    const preferences = value.split(',');
    if (preferences.length > MAX_LANGUAGE_PREFERENCES) return null;
    let selected: Locale | null = null;
    let selectedWeight = 0;
    for (const preference of preferences) {
        const [tag, ...parameters] = preference.trim().split(';');
        const locale = normalizeLocale(tag);
        const weight = preferenceWeight(parameters);
        if (locale && weight !== null && weight > selectedWeight) {
            selected = locale;
            selectedWeight = weight;
        }
    }
    return selected;
}

/** Read the first locale cookie as a display preference; malformed escapes and headers over 8 KiB are ignored. */
export function resolveLocaleCookie(value: unknown): Locale | null {
    if (typeof value !== 'string' || value.length > MAX_COOKIE_HEADER_LENGTH) {
        return null;
    }
    const cookie = value
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('locale='));
    if (!cookie) return null;
    try {
        return normalizeLocale(
            decodeURIComponent(cookie.slice('locale='.length))
        );
    } catch {
        return null;
    }
}

/**
 * Prefer a decoded cookie value, then a saved preference, then weighted browser languages.
 * An explicit supported fallback may override English. A browser q=0 entry never wins
 * selection; when no preference wins, the configured fallback still applies.
 */
export function resolveLocale(
    preferences: {
        cookieLocale?: unknown;
        savedLocale?: unknown;
        acceptLanguage?: unknown;
        fallback?: unknown;
    } = {}
): Locale {
    return (
        normalizeLocale(preferences.cookieLocale) ??
        normalizeLocale(preferences.savedLocale) ??
        resolveAcceptLanguageLocale(preferences.acceptLanguage) ??
        normalizeLocale(preferences.fallback) ??
        defaultLocale
    );
}

/** Keep the dashboard's existing two-argument cookie/browser interface. */
export function resolveRequestLocale(
    cookieLocale: string | null | undefined,
    acceptLanguage: string | null
): Locale {
    return resolveLocale({ cookieLocale, acceptLanguage });
}
