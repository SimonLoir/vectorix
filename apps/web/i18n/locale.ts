'use server';

import { cookies } from 'next/headers';
import { supportedLocales, type Locale } from './locales';

export async function setLocale(locale: string) {
    if (!(supportedLocales as readonly string[]).includes(locale)) return;
    const cookieStore = await cookies();
    cookieStore.set('locale', locale as Locale, {
        path: '/',
        maxAge: 60 * 60 * 24 * 365, // 1 year
        sameSite: 'lax',
    });
}
