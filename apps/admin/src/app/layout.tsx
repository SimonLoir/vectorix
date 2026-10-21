import type { Metadata } from 'next';
import { createTranslator } from 'next-intl';
import './globals.css';
import { Providers } from './providers';
import { getAdminIntl } from '@/i18n/request';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const intl = await getAdminIntl();
    const t = createTranslator({ ...intl, namespace: 'admin.metadata' });
    return { title: t('title'), description: t('description') };
}

export default async function RootLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    const { locale, messages } = await getAdminIntl();
    const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

    return (
        <html lang={locale} suppressHydrationWarning>
            <body>
                <Providers apiUrl={apiUrl} locale={locale} messages={messages}>
                    {children}
                </Providers>
            </body>
        </html>
    );
}
