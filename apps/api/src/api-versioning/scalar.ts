import type { PublicApiVersion } from './registry';
import { SCALAR_ICON_PATH } from './scalar-icon';

/** Builds Scalar's multi-document configuration directly from the registry. */
export function createScalarConfig(versions: readonly PublicApiVersion[]) {
    return {
        sources: versions.map((version) => ({
            title: `Vectorix API v${version.major} (revision ${version.revision})`,
            slug: `v${version.major}`,
            url: version.specPath,
            default: version.status === 'current',
        })),
        showDeveloperTools: 'never',
        withDefaultFonts: false,
        telemetry: false,
        persistAuth: false,
        agent: { disabled: true },
        mcp: { disabled: true },
        authentication: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key',
                },
            },
        },
    };
}

type ScalarHtmlOptions = Readonly<{
    nonce: string;
    bundlePath: string;
    integrity: string;
}>;

function attribute(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/** Scalar requires inline CSS, while every executable script remains nonce-authorized. */
export function scalarContentSecurityPolicy(nonce: string): string {
    if (!/^[A-Za-z0-9+/]{32}$/u.test(nonce))
        throw new Error('Invalid playground nonce.');
    return [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ].join('; ');
}

/**
 * Render only registry-derived configuration and a local bundle. The nonce/meta
 * pairing authorizes Scalar's stylesheet hook; it never changes request
 * credentials, authentication or the server's trusted-origin policy.
 */
export function renderScalarHtml(
    versions: readonly PublicApiVersion[],
    { nonce, bundlePath, integrity }: ScalarHtmlOptions
) {
    const configuration = JSON.stringify(createScalarConfig(versions))
        .replaceAll('<', String.raw`\u003c`)
        .replaceAll('\u2028', String.raw`\u2028`)
        .replaceAll('\u2029', String.raw`\u2029`);

    return `
    <!doctype html>
    <html>
      <head>
        <title>Vectorix API</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta property="csp-nonce" content="${attribute(nonce)}" />
        <link rel="icon" type="image/svg+xml" href="${SCALAR_ICON_PATH}" />
      </head>
      <body>
        <div id="app"></div>
        <script nonce="${attribute(nonce)}" src="${attribute(bundlePath)}" integrity="${attribute(integrity)}"></script>
        <script nonce="${attribute(nonce)}">
          Scalar.createApiReference('#app', ${configuration})
        </script>
      </body>
    </html>
  `;
}
