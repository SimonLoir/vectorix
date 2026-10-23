/**
 * Protect frontend documents from framing without restricting their scripts,
 * styles or API connections. HSTS remains the TLS operator's policy. Each call
 * returns fresh rules so an application's exceptions cannot mutate another's.
 *
 * @returns {{source: string, headers: {key: string, value: string}[]}[]}
 */
export function dashboardSecurityHeaderRules() {
    return [
        {
            source: '/:path*',
            headers: [
                {
                    key: 'Content-Security-Policy',
                    value: "frame-ancestors 'none'",
                },
                { key: 'X-Frame-Options', value: 'DENY' },
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'Referrer-Policy', value: 'no-referrer' },
            ],
        },
    ];
}
