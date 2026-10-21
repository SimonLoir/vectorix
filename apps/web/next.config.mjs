import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
    transpilePackages: [
        '@repo/api',
        '@repo/db',
        '@repo/ui',
        '@repo/dashboard-core',
    ],
    serverExternalPackages: ['@dotenvx/dotenvx'],
    async headers() {
        return [
            {
                source: '/sw.js',
                headers: [
                    {
                        key: 'Content-Type',
                        value: 'application/javascript; charset=utf-8',
                    },
                    {
                        key: 'Cache-Control',
                        value: 'no-cache, no-store, must-revalidate',
                    },
                    {
                        key: 'Content-Security-Policy',
                        value: "default-src 'none'; script-src 'self'",
                    },
                    { key: 'Service-Worker-Allowed', value: '/' },
                ],
            },
        ];
    },
};

export default withNextIntl(nextConfig);
