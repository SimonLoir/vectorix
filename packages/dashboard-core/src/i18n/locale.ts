export const supportedLocales = ['en', 'fr', 'nl-BE'] as const;
export type Locale = (typeof supportedLocales)[number];
export const defaultLocale: Locale = 'en';

function isSupportedLocale(value: string | null | undefined): value is Locale {
    return Boolean(
        value && (supportedLocales as readonly string[]).includes(value)
    );
}

function normalizeBrowserLocale(value: string): Locale | null {
    const normalized = value.toLowerCase();

    if (normalized === 'fr' || normalized.startsWith('fr-')) return 'fr';
    if (normalized === 'nl' || normalized.startsWith('nl-')) return 'nl-BE';
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en';

    return null;
}

function resolveAcceptLanguageLocale(
    acceptLanguage: string | null
): Locale | null {
    if (!acceptLanguage) return null;

    return (
        acceptLanguage
            .split(',')
            .map((part, index) => {
                const [rawTagValue, ...rawParams] = part.trim().split(';');
                const rawTag = rawTagValue?.trim();
                if (!rawTag) return null;

                const locale = normalizeBrowserLocale(rawTag);
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
                ): entry is { locale: Locale; q: number; index: number } =>
                    entry !== null
            )
            .toSorted((a, b) => b.q - a.q || a.index - b.index)[0]?.locale ??
        null
    );
}

/** Prefer a supported locale cookie, then weighted browser languages, then English. */
export function resolveRequestLocale(
    cookieLocale: string | null | undefined,
    acceptLanguage: string | null
): Locale {
    if (isSupportedLocale(cookieLocale)) return cookieLocale;

    return resolveAcceptLanguageLocale(acceptLanguage) ?? defaultLocale;
}
