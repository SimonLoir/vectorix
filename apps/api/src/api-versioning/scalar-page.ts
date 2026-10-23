import { randomBytes } from 'node:crypto';
import type { Handler } from 'hono';
import type { PublicApiVersion } from './registry';
import { loadScalarBundle, type ScalarBundle } from './scalar-bundle';
import { renderScalarHtml, scalarContentSecurityPolicy } from './scalar';

/** Render one no-store page with a fresh nonce; asset failure affects only the playground. */
export function createScalarPageHandler(
    versions: readonly PublicApiVersion[],
    load: () => ScalarBundle = loadScalarBundle
): Handler {
    return (context) => {
        context.header('Cache-Control', 'no-store');
        context.header('X-Content-Type-Options', 'nosniff');
        context.header('Referrer-Policy', 'no-referrer');
        context.header('X-Frame-Options', 'DENY');
        try {
            const bundle = load();
            const nonce = randomBytes(24).toString('base64');
            context.header(
                'Content-Security-Policy',
                scalarContentSecurityPolicy(nonce)
            );
            return context.html(
                renderScalarHtml(versions, {
                    nonce,
                    bundlePath: bundle.assetPath,
                    integrity: bundle.integrity,
                })
            );
        } catch {
            context.header(
                'Content-Security-Policy',
                "default-src 'none'; frame-ancestors 'none'"
            );
            return context.text('API playground is unavailable.', 503);
        }
    };
}
