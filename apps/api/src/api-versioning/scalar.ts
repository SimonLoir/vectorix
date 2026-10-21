import type { PublicApiVersion } from './registry';

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
        authentication: {
            ApiKeyAuth: {
                type: 'apiKey',
                in: 'header',
                name: 'x-api-key',
            },
        },
    };
}

/** Renders the API playground with all supported major versions selectable. */
export function renderScalarHtml(versions: readonly PublicApiVersion[]) {
    const configuration = JSON.stringify(
        createScalarConfig(versions)
    ).replaceAll('<', String.raw`\u003c`);

    return `
    <!doctype html>
    <html>
      <head>
        <title>Vectorix API</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="https://orpc.dev/icon.svg" />
      </head>
      <body>
        <div id="app"></div>
        <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
        <script>
          Scalar.createApiReference('#app', ${configuration})
        </script>
      </body>
    </html>
  `;
}
