import type { Handler } from 'hono';
import { loadScalarBundle, type ScalarBundle } from './scalar-bundle';

/** Bounded conditional GET parsing; weak validators and wildcard follow normal If-None-Match semantics. */
function unchanged(value: string | undefined, etag: string): boolean {
    return Boolean(
        value &&
        value.length <= 1024 &&
        value.split(',').some((item) => {
            const tag = item.trim();
            return tag === '*' || tag === etag || tag === `W/${etag}`;
        })
    );
}

/** Serve only the currently installed content hash; this is never a filesystem/static-directory route. */
export function createScalarAssetHandler(
    load: () => ScalarBundle = loadScalarBundle
): Handler {
    return (context) => {
        context.header('X-Content-Type-Options', 'nosniff');
        context.header('Cache-Control', 'no-store');
        // Hono's routing path is decoded; the public asset identity is one exact
        // serialized pathname, so encoded aliases must not acquire that identity.
        const pathname = new URL(context.req.url).pathname;
        if (!/^\/_playground\/scalar\/[a-f0-9]{64}\.js$/u.test(pathname))
            return context.notFound();
        let bundle: ScalarBundle;
        try {
            bundle = load();
        } catch {
            return context.text('API playground is unavailable.', 503);
        }
        if (pathname !== bundle.assetPath) return context.notFound();
        context.header('Content-Type', 'application/javascript; charset=utf-8');
        context.header('Cache-Control', 'public, max-age=31536000, immutable');
        context.header('ETag', bundle.etag);
        if (unchanged(context.req.header('If-None-Match'), bundle.etag))
            return context.body(null, 304);
        context.header('Content-Length', String(bundle.bytes.byteLength));
        return context.body(bundle.bytes);
    };
}
