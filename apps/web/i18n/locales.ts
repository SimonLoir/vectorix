export const supportedLocales = ['en', 'fr', 'nl-BE'] as const;
export type Locale = (typeof supportedLocales)[number];
