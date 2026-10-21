import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Administration Vectorix',
    description: 'Gestion des organisations et fonctionnalités Vectorix.',
};

export default function RootLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    const apiUrl = process.env.API_URL ?? 'http://localhost:3001';

    return (
        <html lang='fr' suppressHydrationWarning>
            <body>
                <Providers apiUrl={apiUrl}>{children}</Providers>
            </body>
        </html>
    );
}
