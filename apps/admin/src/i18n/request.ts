import { cookies, headers } from 'next/headers';
import { resolveRequestLocale } from '@repo/dashboard-core/i18n/locale';

const dictionaries = {
    en: () => import('../messages/en.json'),
    fr: () => import('../messages/fr.json'),
    'nl-BE': () => import('../messages/nl-BE.json'),
};

/** Use the same locale cookie and Accept-Language resolution as the web dashboard. */
export async function getAdminIntl() {
    const [cookieStore, requestHeaders] = await Promise.all([
        cookies(),
        headers(),
    ]);
    const locale = resolveRequestLocale(
        cookieStore.get('locale')?.value,
        requestHeaders.get('accept-language')
    );
    const { default: messages } = await dictionaries[locale]();
    return { locale, messages };
}
