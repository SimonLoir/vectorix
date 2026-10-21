'use server';
import { cookies } from 'next/headers';
import { supportedLocales } from '@repo/dashboard-core/i18n/locale';

/** Persist a supported display language only; this action has no authorization effects. */
export async function setAdminLocale(locale: string) {
    if (!(supportedLocales as readonly string[]).includes(locale)) return;
    (await cookies()).set('locale', locale, {
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
        sameSite: 'lax',
    });
}
