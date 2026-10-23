/** Compatibility entrypoint; shared locale resolution has no frontend runtime dependencies. */
export {
    defaultLocale,
    normalizeLocale,
    resolveAcceptLanguageLocale,
    resolveLocale,
    resolveLocaleCookie,
    resolveRequestLocale,
    supportedLocales,
    type Locale,
} from '@repo/i18n/locale';
