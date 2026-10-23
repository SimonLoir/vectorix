import type { DBFieldAttribute } from 'better-auth/db';
import {
    normalizeLocale,
    supportedLocales,
    type Locale,
} from '@repo/i18n/locale';

/** Only canonical dictionary identifiers may be persisted through the native user endpoint. */
export function isCanonicalUserLocale(value: unknown): value is Locale {
    return typeof value === 'string' && normalizeLocale(value) === value;
}

/**
 * Browser-safe field metadata shared by server configuration and SDK inference.
 * The existing nullable column remains unchanged; only new users receive English
 * by default. Sensitive built-in and plugin fields retain their native input rules.
 */
export const userLocaleFields = {
    locale: {
        type: [...supportedLocales],
        required: false,
        input: true,
        defaultValue: 'en',
        validator: {
            input: {
                '~standard': {
                    version: 1,
                    vendor: 'vectorix',
                    validate(value: unknown) {
                        return isCanonicalUserLocale(value)
                            ? { value }
                            : {
                                  issues: [
                                      {
                                          message:
                                              'Choose a supported account language.',
                                      },
                                  ],
                              };
                    },
                },
            },
        },
    },
} satisfies Record<string, DBFieldAttribute>;
