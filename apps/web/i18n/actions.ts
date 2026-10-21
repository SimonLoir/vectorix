'use server';

import { type Locale } from '@/i18n/request';
import { cookies, headers } from 'next/headers';
import { resolveRequestLocale } from '@/i18n/resolveLocale';

export async function getIntl(): Promise<{
    locale: Locale;
    messages: Record<string, unknown>;
}> {
    const [cookieStore, headersList] = await Promise.all([
        cookies(),
        headers(),
    ]);
    const cookieLocale = cookieStore.get('locale')?.value;
    const locale: Locale = resolveRequestLocale(
        cookieLocale,
        headersList.get('accept-language')
    );

    const messages = (await import(`../messages/${locale}.json`))
        .default as Record<string, unknown>;

    return { locale, messages };
}
