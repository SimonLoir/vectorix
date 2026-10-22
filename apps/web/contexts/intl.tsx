'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    type ReactNode,
} from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { setLocale as persistLocale } from '@/i18n/locale';
import { type Locale } from '@/i18n/request';
import { getIntl } from '@/i18n/actions';
import { defaultLocale } from '@/i18n/defaultLocale';

const messageImports: Record<
    Locale,
    () => Promise<{ default: Record<string, unknown> }>
> = {
    en: () => import('@/messages/en.json'),
    fr: () => import('@/messages/fr.json'),
    'nl-BE': () => import('@/messages/nl-BE.json'),
};

interface IntlContextValue {
    locale: Locale;
    setLocale: (locale: Locale) => void;
}

const IntlContext = createContext<IntlContextValue | null>(null);

export function useIntl() {
    const ctx = useContext(IntlContext);
    if (!ctx) throw new Error('useIntl must be used within IntlProvider');
    return ctx;
}

export function IntlProvider({
    children,
}: Readonly<{
    children: ReactNode;
}>) {
    const queryClient = useQueryClient();

    // Fetch current locale + messages from the server (reads the cookie)
    const { data } = useQuery({
        queryKey: ['intl'],
        queryFn: () => getIntl(),
        staleTime: Infinity,
    });

    const locale: Locale = data?.locale ?? defaultLocale;
    const messages = data?.messages;

    const setLocale = useCallback(
        async (newLocale: Locale) => {
            // Persist cookie for SSR consistency
            await persistLocale(newLocale);
            // Load new messages client-side (no round-trip for the JSON)
            const mod = await messageImports[newLocale]();
            queryClient.setQueryData<Awaited<ReturnType<typeof getIntl>>>(
                ['intl'],
                (previous) =>
                    previous
                        ? {
                              ...previous,
                              locale: newLocale,
                              messages: mod.default as Record<string, unknown>,
                          }
                        : undefined
            );
        },
        [queryClient]
    );

    // Keep <html lang="..."> in sync
    useEffect(() => {
        document.documentElement.lang = locale;
    }, [locale]);

    if (!messages) return null;

    return (
        <IntlContext value={{ locale, setLocale }}>
            <NextIntlClientProvider
                locale={locale}
                messages={messages}
                timeZone={data?.timeZone}
            >
                {children}
            </NextIntlClientProvider>
        </IntlContext>
    );
}
