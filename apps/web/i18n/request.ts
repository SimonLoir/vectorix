import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import { resolveRequestLocale } from '@/i18n/resolveLocale';
import { type Locale } from '@/i18n/locales';
import { resolveVectorixTimeZone } from '@repo/dashboard-core/i18n/time-zone';

export { supportedLocales, type Locale } from '@/i18n/locales';

export default getRequestConfig(async () => {
    const [cookieStore, headersList] = await Promise.all([
        cookies(),
        headers(),
    ]);
    const cookieLocale = cookieStore.get('locale')?.value;
    const locale: Locale = resolveRequestLocale(
        cookieLocale,
        headersList.get('accept-language')
    );

    return {
        locale,
        timeZone: resolveVectorixTimeZone(process.env.VECTORIX_TIME_ZONE),
        messages: (await import(`../messages/${locale}.json`))
            .default as Record<string, unknown>,
    };
});
