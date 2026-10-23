# Shared language and time-zone resolution

`@repo/i18n` contains dependency-free helpers for browser/server dashboards, native authentication mail and notification workers. It performs no environment reads, network requests or persistence. Import `@repo/i18n/locale` or `@repo/i18n/time-zone`; the package root exports both.

Supported dictionary identifiers are `en`, `fr` and `nl-BE`. `normalizeLocale` maps bounded regional English, French and Dutch tags to those identifiers and returns `null` for invalid/unsupported values. `resolveLocale` prefers a decoded locale cookie, then a saved preference, then weighted `Accept-Language`, then an explicit supported fallback, then English. Zero-weight, malformed and unsupported browser entries cannot win; ties retain header order. Oversized inputs are ignored rather than partially trusted.

`resolveLocaleCookie` safely decodes the first locale cookie from a bounded header. `resolveRequestLocale(cookie, acceptLanguage)` preserves the existing dashboard interface. `@repo/dashboard-core/i18n/*` reexports these helpers for compatibility; server workers must import this lightweight package rather than dashboard components.

`resolveVectorixTimeZone` validates a supplied identifier with `Intl` and uses `Europe/Brussels` for missing, empty or invalid input. Locale and deployment time zone remain independent. Callers read deployment settings on the server and pass only public resolved values to their consumers.

Account preference writes accept only canonical identifiers through the native current-user endpoint; normalization of historical regional values does not make them valid write inputs. See [account and notification localization](../../docs/account-notification-localization.md) for persistence, mail precedence and acceptance.
