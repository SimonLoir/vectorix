import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
import { dashboardSecurityHeaderRules } from '@repo/dashboard-core/config/security-headers';

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
            ...dashboardSecurityHeaderRules(),
            // Next uses the last matching value for a header. Preserve the
            // service worker's stronger policy after the general page rule.
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
                        value: "default-src 'none'; script-src 'self'; frame-ancestors 'none'",
                    },
                    { key: 'Service-Worker-Allowed', value: '/' },
                ],
            },
        ];
    },
};

export default withNextIntl(nextConfig);
