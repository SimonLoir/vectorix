import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@repo/dashboard-core/components/theme-provider';
import { Toaster } from '@repo/ui/sonner';
import { ApplicationProviders } from '@/components/application-providers';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
    title: 'Vectorix',
    description: 'Votre espace de travail.',
    manifest: '/manifest.webmanifest',
    icons: {
        icon: '/icons/app.svg',
    },
    appleWebApp: {
        capable: true,
        title: 'Vectorix',
        statusBarStyle: 'default',
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html suppressHydrationWarning>
            <body>
                <ThemeProvider
                    attribute='class'
                    defaultTheme='system'
                    enableSystem
                    disableTransitionOnChange
                >
                    <ApplicationProviders
                        apiUrl={process.env.API_URL ?? 'http://localhost:3001'}
                    >
                        {children}
                    </ApplicationProviders>
                    <Toaster />
                </ThemeProvider>
            </body>
        </html>
    );
}
