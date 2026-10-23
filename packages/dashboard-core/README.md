# Dashboard core

`@repo/dashboard-core` provides shared dashboard components, authentication context and forms, and locale/time-zone helpers for web and administration. Its public subpaths are listed in the [package manifest](package.json). Application-specific server configuration and provider composition remain in each application.

## Public internationalization entry points

| Import                                              | Exports                                                               | Responsibility                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `@repo/dashboard-core/i18n/locale`                  | `supportedLocales`, `defaultLocale`, `Locale`, `resolveRequestLocale` | Resolve the display language from a supported cookie, weighted browser languages, then English.  |
| `@repo/dashboard-core/i18n/time-zone`               | `DEFAULT_VECTORIX_TIME_ZONE`, `resolveVectorixTimeZone`               | Validate a supplied time zone with `Intl`; preserve the default `Europe/Brussels` fallback.      |
| `@repo/dashboard-core/components/language-switcher` | `LanguageSwitcher`, `LanguageOption`, `LanguageSwitcherProps`         | Render language choices supplied by the application; the caller handles persistence and refresh. |

The compatibility locale/time-zone entry points reexport dependency-free [`@repo/i18n`](../i18n/README.md), also used by auth mail and workers. The [locale helper](src/i18n/locale.ts) supports `en`, `fr` and `nl-BE`. Locale selects messages and formatting conventions; it does not select the deployment time zone. The [time-zone helper](src/i18n/time-zone.ts) accepts a value, not an environment-variable name, and performs no environment read itself. It trims the supplied value and checks it with `Intl.DateTimeFormat`. Missing, empty or invalid values resolve to `Europe/Brussels`; accepted values retain their trimmed identifier.

## Server configuration and provider lifecycle

Applications read `VECTORIX_TIME_ZONE` on the server and pass only the validated public result to `NextIntlClientProvider`. Do not read deployment settings in a client component, introduce `NEXT_PUBLIC_*` settings, or bake deployment values into frontend builds.

- Administration: [getAdminIntl](../../apps/admin/src/i18n/request.ts) resolves locale, messages and time zone. The [server layout](../../apps/admin/src/app/layout.tsx) forwards all three values to the client [Providers](../../apps/admin/src/app/providers.tsx), where `timeZone` is a required prop and is forwarded explicitly to `NextIntlClientProvider`.
- Web: [request configuration](../../apps/web/i18n/request.ts) and the [getIntl server action](../../apps/web/i18n/actions.ts) use the same shared resolver. The existing client [IntlProvider](../../apps/web/contexts/intl.tsx) forwards the server result to `NextIntlClientProvider` and preserves that time zone when updating messages for a language change.
- Language selection uses the shared single-flight preference hook: an explicit signed-in choice must succeed through native `updateUser({locale})` before local display persistence; anonymous choices remain display-only. The cookie actions remain application-owned: [admin action](../../apps/admin/src/i18n/actions.ts), [web action](../../apps/web/i18n/locale.ts). The shared switcher receives the selected locale, choices, localized accessible label and change callback through props.

Restart the affected web/admin deployment consumers after changing configuration and reload open pages so existing client data is refreshed. The configured zone applies to consumers using that provider's formatting context; this is not a promise that every legacy formatter uses it. For example, the existing [web notification list](../../apps/web/components/notifications/notification-list.tsx) still has an explicit Brussels formatter.

See [Dashboard time zones](../../docs/dashboard-timezones.md) for the runtime flow, exact fallback behavior, acceptance recipe and recorded validation status. No database or public API DTO changes are required for the shared resolver and explicit admin-provider prop.

## Static frontend security configuration

`@repo/dashboard-core/config/security-headers` exports `dashboardSecurityHeaderRules()` as dependency-free ESM with TypeScript declarations. Both Next configurations consume fresh rule/header objects to set framing, MIME and referrer protections. Keep application-specific exceptions after the shared rules; web retains its stronger `/sw.js` policy. This config import performs no environment read or React/auth initialization. Rebuild frontends after policy changes and preserve headers at the edge. See [dashboard security headers](../../docs/dashboard-security-headers.md) for exact values, framework response limits and acceptance.
