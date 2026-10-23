import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { dashboardSecurityHeaderRules } from '@repo/dashboard-core/config/security-headers';

const nextConfig: NextConfig = {
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
    headers: dashboardSecurityHeaderRules,
};

export default nextConfig;
